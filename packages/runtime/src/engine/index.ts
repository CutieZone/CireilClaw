import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import path from "node:path";

import { KeyPoolManager } from "@cireilclaw/sdk";
import * as vb from "valibot";

import {
  loadAgentPluginConfig,
  loadEngine,
  loadGlobalPluginConfig,
  loadSandboxConfig,
  loadTools,
} from "#config/index.js";
import type { ConditionsConfig } from "#config/schemas/conditions.js";
import { DefaultReasoningBudget, DefaultToolFailThreshold } from "#config/schemas/engine.js";
import { getDb } from "#db/index.js";
import { hashImage } from "#db/sessions.js";
import type { ToolCallContent } from "#engine/content.js";
import {
  computeContextUsageSnapshot,
  formatContextPruneWarning,
  formatPromptMetadata,
} from "#engine/context-usage.js";
import type { Context, UsageInfo } from "#engine/context.js";
import { GenerationNoToolCallsError, ToolError, ParseError } from "#engine/errors.js";
import { generate as generateAnthropic } from "#engine/provider/anthropic.js";
import { resolveModelContextWindow } from "#engine/provider/model-metadata.js";
import { generate as generateOai } from "#engine/provider/oai.js";
import { generate as generateOpenAiCodex } from "#engine/provider/openai-codex.js";
import { buildOpenedFilesBlock, buildSystemPrompt } from "#engine/system-prompt.js";
import { getToolRegistry } from "#engine/tools/index.js";
import type { ToolContext } from "#engine/tools/tool-def.js";
import type {
  ChannelCapabilities,
  ChannelResolution,
  HistoryDirection,
  HistoryMessage,
} from "#harness/channel-handler.js";
import type { Session } from "#harness/session.js";
import colors from "#output/colors.js";
import { debug, warning } from "#output/log.js";
import type { Scheduler } from "#scheduler/index.js";
import { formatDate } from "#util/date.js";
import { getDefaultProviderAndModel } from "#util/default-provider-and-model.js";
import {
  checkConditionalAccess,
  checkMountWriteAccess,
  sanitizeError,
  sandboxToReal,
} from "#util/paths.js";
import { stripMediaForModel } from "#util/strip.js";

import type { AssistantMessage, Message, ToolMessage } from "./message.js";
import {
  applyTopicSubstitution,
  estimateSystemPrompt,
  pruneHistory,
  squashMessages,
} from "./prune.js";
import { buildTools } from "./tools.js";

const NO_CAPABILITIES: ChannelCapabilities = {
  supportsAttachments: false,
  supportsDownloadAttachments: false,
  supportsReactions: false,
};

function logUsage(
  agentSlug: string,
  sessionId: string,
  systemPromptLength: number,
  usage: UsageInfo | undefined,
): void {
  const sysEst = Math.round(systemPromptLength / 4);

  if (usage === undefined) {
    // No usage info from API — log the system prompt estimate only.
    debug(
      "Token usage (estimated)",
      colors.keyword(agentSlug),
      colors.keyword(sessionId),
      `sys est: ~${colors.number(sysEst)} tokens`,
    );
  } else {
    debug(
      "Token usage",
      colors.keyword(agentSlug),
      colors.keyword(sessionId),
      `ctx: ${colors.number(usage.promptTokens)} tokens`,
      `sys est: ~${colors.number(sysEst)} tokens`,
      `gen: ${colors.number(usage.completionTokens)} tokens`,
    );
  }
}

// oxlint-disable-next-line typescript/require-await
async function resolveChannelUnsupported(_spec: string): Promise<ChannelResolution> {
  return { error: "channel resolution not supported" };
}

export async function runTurn(
  session: Session,
  agentSlug: string,
  override: {
    provider?: string;
    model?: string;
  },
  send: (content: string, attachments?: string[]) => Promise<void>,
  sendTo: (targetSession: Session, content: string, attachments?: string[]) => Promise<void>,
  react?: (emoji: string, messageId?: string) => Promise<void>,
  downloadAttachments?: (messageId: string) => Promise<{ filename: string; data: Buffer }[]>,
  fetchHistory?: (
    messageId: string,
    direction: HistoryDirection,
    limit?: number,
  ) => Promise<HistoryMessage[]>,
  resolveChannel?: (spec: string) => Promise<ChannelResolution>,
  capabilities: ChannelCapabilities = NO_CAPABILITIES,
  conditions?: ConditionsConfig,
  scheduler?: Scheduler,
): Promise<void> {
  const engineCfg = await loadEngine(agentSlug);
  const engineDefaults = getDefaultProviderAndModel(engineCfg);
  const toolsConfig = await loadTools(agentSlug);
  const tools = await buildTools(agentSlug, session, toolsConfig);
  const sandboxConfig = await loadSandboxConfig(agentSlug);
  const ctx: ToolContext = {
    addImage: (data: Uint8Array, mediaType: string): void => {
      session.pendingImages.push({ data, mediaType, type: "image" });
    },
    addToolMessage: (content: string): void => {
      session.pendingToolMessages.push({
        content: { content, type: "text" },
        role: "user",
      });
    },
    addVideo: (data: Uint8Array, mediaType: string): void => {
      session.pendingVideos.push({
        attachmentId: "",
        data,
        mediaType,
        type: "video",
        url: "",
      });
    },
    agentSlug,
    cfg: {
      agentPlugin: async (name) => await loadAgentPluginConfig(agentSlug, name),
      exec: toolsConfig.exec,
      globalPlugin: async (name) => await loadGlobalPluginConfig(name),
      sandbox: sandboxConfig,
    },
    channel: {
      downloadAttachments,
      fetchHistory,
      resolveChannel: resolveChannel ?? resolveChannelUnsupported,
    },
    conditions,
    createKeyPool: (keys, cooldownMs) => KeyPoolManager.getPool(keys, cooldownMs),
    crypto: {
      loadNormalizedKey: async (
        opts: { path: string } | { data: string },
      ): Promise<{ format: "pkcs8" | "spki"; data: string }> => {
        let rawKey = "";
        if ("path" in opts) {
          const realPath = sandboxToReal(opts.path, agentSlug, sandboxConfig.mounts);
          if (conditions !== undefined) {
            checkConditionalAccess(opts.path, agentSlug, conditions, session);
          }
          rawKey = await readFile(realPath, "utf8");
        } else {
          rawKey = opts.data;
        }

        try {
          const privateKey = createPrivateKey(rawKey);
          return {
            data: privateKey.export({ format: "pem", type: "pkcs8" }),
            format: "pkcs8",
          };
        } catch {
          // Not a private key.
        }

        const publicKey = createPublicKey(rawKey);
        return {
          data: publicKey.export({ format: "pem", type: "spki" }),
          format: "spki",
        };
      },
    },
    db: getDb(agentSlug),
    fs: {
      listDir: async (
        sandboxPath: string,
      ): Promise<{ name: string; isDirectory: boolean; isFile: boolean }[]> => {
        const realPath = sandboxToReal(sandboxPath, agentSlug, sandboxConfig.mounts);
        if (conditions !== undefined) {
          checkConditionalAccess(sandboxPath, agentSlug, conditions, session);
        }
        const entries = await readdir(realPath, { withFileTypes: true });
        return entries.map((entry) => ({
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          name: entry.name,
        }));
      },
      readTextFile: async (sandboxPath: string): Promise<string> => {
        const realPath = sandboxToReal(sandboxPath, agentSlug, sandboxConfig.mounts);
        if (conditions !== undefined) {
          checkConditionalAccess(sandboxPath, agentSlug, conditions, session);
        }
        return await readFile(realPath, "utf8");
      },
      stat: async (
        sandboxPath: string,
      ): Promise<{
        ctimeMs: number;
        isDirectory: boolean;
        isFile: boolean;
        mtimeMs: number;
        size: number;
      }> => {
        const realPath = sandboxToReal(sandboxPath, agentSlug, sandboxConfig.mounts);
        if (conditions !== undefined) {
          checkConditionalAccess(sandboxPath, agentSlug, conditions, session);
        }
        const stats = await stat(realPath);
        return {
          ctimeMs: stats.ctimeMs,
          isDirectory: stats.isDirectory(),
          isFile: stats.isFile(),
          mtimeMs: stats.mtimeMs,
          size: stats.size,
        };
      },
      writeTextFile: async (sandboxPath: string, content: string): Promise<void> => {
        const realPath = sandboxToReal(sandboxPath, agentSlug, sandboxConfig.mounts);
        checkMountWriteAccess(sandboxPath, sandboxConfig.mounts);
        if (conditions !== undefined) {
          checkConditionalAccess(sandboxPath, agentSlug, conditions, session);
        }
        await mkdir(path.dirname(realPath), { recursive: true });
        await writeFile(realPath, content, "utf8");
      },
    },
    mounts: sandboxConfig.mounts,
    net: {
      fetch: globalThis.fetch.bind(globalThis),
    },
    paths: {
      // oxlint-disable-next-line typescript/require-await
      checkConditionalAccess: async (sandboxPath: string): Promise<void> => {
        if (conditions !== undefined) {
          checkConditionalAccess(sandboxPath, agentSlug, conditions, session);
        }
      },
      // oxlint-disable-next-line typescript/require-await
      checkWriteAccess: async (sandboxPath: string): Promise<void> => {
        checkMountWriteAccess(sandboxPath, sandboxConfig.mounts);
      },
      // oxlint-disable-next-line typescript/require-await
      resolve: async (sandboxPath: string): Promise<string> =>
        sandboxToReal(sandboxPath, agentSlug, sandboxConfig.mounts),
    },
    reply: {
      react,
      send,
      sendTo,
    },
    scheduler,
    session,
  };

  debug("Turn start", colors.keyword(agentSlug), colors.keyword(session.id()));

  const providerName = override.provider ?? session.selectedProvider;
  let selectedProvider =
    providerName === undefined ? engineDefaults.provider.config : engineCfg[providerName];

  if (selectedProvider === undefined) {
    warning(
      `Provider '${providerName}' not found in config, falling back to default`,
      colors.keyword(agentSlug),
      colors.keyword(session.id()),
    );
    selectedProvider = engineDefaults.provider.config;
  }

  const selectedModel = override.model ?? session.selectedModel ?? engineDefaults.model.name;

  const modelCfg = selectedProvider.models?.[selectedModel] ??
    engineDefaults.model.config ?? {
      contextBudget: 0.6,
      contextHardBudget: 0.85,
      reasoning: true,
      reasoningBudget: DefaultReasoningBudget,
      supportsVideo: false,
      supportsVision: true,
      toolFailThreshold: DefaultToolFailThreshold,
    };

  const contextBudget = modelCfg.contextBudget ?? 0.6;
  const contextHardBudget = modelCfg.contextHardBudget ?? 0.85;
  const effectiveContextWindow = await resolveModelContextWindow(
    selectedProvider,
    selectedModel,
    modelCfg,
  );

  let generationRetries = 0;
  const toolConsecutiveFailures = new Map<string, number>();
  const disabledTools = new Set<string>();

  const { toolFailThreshold } = modelCfg;

  for (;;) {
    // If tools or Discord queued images/videos, inject them as a user message
    // AFTER pending tool responses. The OAI API only allows images/video in
    // user-role messages, and they must come after the matching tool responses.

    const seenImages = new Set<string>();
    const dedupedImages = session.pendingImages.filter((img) => {
      const hash = hashImage(img.data);
      if (seenImages.has(hash)) {
        return false;
      }
      seenImages.add(hash);
      return true;
    });
    session.pendingImages = dedupedImages;

    if (session.pendingImages.length > 0 || session.pendingVideos.length > 0) {
      const images = session.pendingImages.splice(0);
      const videos = session.pendingVideos.splice(0);

      if (selectedProvider.useFilesApi === "kimi" && videos.length > 0) {
        // Kimi's coding endpoint rejects video_url in user messages.
        // Fake a tool call + response so the video lives in a tool message.
        const fakeId = `recv-video-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        debug(
          `useFilesApi=kimi: faking receive_video tool call (${fakeId}) for ${videos.length} video(s), ${images.length} image(s)`,
        );
        session.pendingToolMessages.push({
          content: [
            {
              id: fakeId,
              input: {},
              name: "receive_video",
              type: "toolCall",
            },
          ],
          role: "assistant",
        });
        session.pendingToolMessages.push({
          content: {
            id: fakeId,
            name: "receive_video",
            output: { _media: [...images, ...videos] },
            type: "toolResponse",
          },
          role: "toolResponse",
        });
      } else {
        const media = [...images, ...videos];
        session.pendingToolMessages.push({ content: media, role: "user" });
      }
    }

    const prompt = await buildSystemPrompt(
      agentSlug,
      session,
      capabilities,
      conditions,
      modelCfg.supportsVision,
      modelCfg.supportsVideo,
    );

    const openedFilesBlock = await buildOpenedFilesBlock(agentSlug, session);
    const openedFilesTokens =
      openedFilesBlock.length > 0 ? estimateSystemPrompt(openedFilesBlock) : 0;

    const systemTokens = estimateSystemPrompt(prompt) + openedFilesTokens;
    const { modifiedHistory, newCursor } = pruneHistory(
      session.history,
      session.historyCursor,
      selectedProvider.maxTurns,
      effectiveContextWindow,
      contextBudget,
      contextHardBudget,
      systemTokens,
    );
    session.history = modifiedHistory;
    session.historyCursor = newCursor;

    const visibleHistory = session.history.slice(session.historyCursor);

    // Step 2: Topic substitution — replace closed topic ranges with summaries.
    // Summaries are applied to the visible history before squashing/pruning.
    let topicSubstituted = visibleHistory;
    if (session.summaries.length > 0) {
      topicSubstituted = applyTopicSubstitution(visibleHistory, session.summaries);
    }

    const messages = squashMessages([...topicSubstituted, ...session.pendingToolMessages]);

    // Blind models don't receive image/video blocks, but they still see attachment
    // metadata via Discord's <attachment> tags and can choose to download them.
    const filteredMessages = stripMediaForModel(
      messages,
      modelCfg.supportsVision,
      modelCfg.supportsVideo,
    );

    // Extract the latest user message so context metadata can sit right
    // before it (after opened files), preventing the agent from confusing
    // a system status ping with the user's actual input.
    const lastUserIdx = filteredMessages.findLastIndex((msg) => msg.role === "user");
    let latestUserMessage: Message | undefined = undefined;
    if (lastUserIdx !== -1) {
      latestUserMessage = filteredMessages.splice(lastUserIdx, 1)[0] as Message | undefined;
    }

    // Inject opened files before the context usage snapshot so token
    // estimates and pruning warnings account for opened-file content.
    if (openedFilesBlock.length > 0) {
      filteredMessages.push({
        content: { content: openedFilesBlock, type: "text" },
        role: "user",
      });
    }

    // Only pass the stable system prompt tokens to avoid double-counting
    // now that opened files are in filteredMessages.
    const stableSystemTokens = estimateSystemPrompt(prompt);
    const usageSnapshot = computeContextUsageSnapshot({
      contextBudget,
      contextHardBudget,
      contextWindow: effectiveContextWindow,
      messages: filteredMessages,
      systemTokens: stableSystemTokens,
    });
    const shouldWarnBeforePrune =
      usageSnapshot.shouldWarnBeforePrune &&
      session.lastContextWarningCursor !== session.historyCursor;

    let promptMetadata = formatPromptMetadata(await formatDate(), usageSnapshot);
    if (shouldWarnBeforePrune) {
      promptMetadata = `${promptMetadata}\n${formatContextPruneWarning(usageSnapshot)}`;
      session.lastContextWarningCursor = session.historyCursor;
    }

    // Inject context metadata after opened files but before the user's
    // latest message, so the agent sees usage info before the latest
    // instruction rather than after it.
    filteredMessages.push({
      content: { content: promptMetadata, type: "text" },
      role: "user",
    });
    if (latestUserMessage !== undefined) {
      filteredMessages.push(latestUserMessage);
    }

    const activeTools = tools.filter((tool) => !disabledTools.has(tool.name));

    const context: Context = {
      cacheBreakpoints: filteredMessages.length > 1 ? [0, filteredMessages.length - 2] : [0],
      messages: filteredMessages,
      sessionId: session.id(),
      systemPrompt: prompt,
      tools: activeTools,
    };

    // oxlint-disable-next-line init-declarations
    let assistantMsg: AssistantMessage;
    let usage: UsageInfo | undefined = undefined;

    const keyPool = KeyPoolManager.getPool(selectedProvider.apiKey);

    try {
      switch (selectedProvider.kind) {
        case "openai": {
          ({ message: assistantMsg, usage } = await generateOai(
            context,
            selectedProvider.apiBase,
            keyPool,
            selectedModel,
            {
              customHeaders: selectedProvider.customHeaders,
              forceJpeg: selectedProvider.useJpegForImages,
              reasoning: modelCfg.reasoning,
              useFilesApi: selectedProvider.useFilesApi,
              useToolChoiceAuto: selectedProvider.useToolChoiceAuto,
            },
          ));
          break;
        }

        case "anthropic": {
          ({ message: assistantMsg, usage } = await generateAnthropic(
            context,
            selectedProvider.apiBase,
            keyPool,
            selectedModel,
            {
              customHeaders: selectedProvider.customHeaders,
              reasoning: modelCfg.reasoning,
              reasoningBudget: modelCfg.reasoningBudget,
            },
          ));
          break;
        }

        case "openai-codex": {
          ({ message: assistantMsg, usage } = await generateOpenAiCodex(
            context,
            selectedProvider.apiBase,
            selectedModel,
            {
              authId: selectedProvider.authId,
              customHeaders: selectedProvider.customHeaders,
              forceJpeg: selectedProvider.useJpegForImages,
              reasoning: modelCfg.reasoning,
            },
          ));
          break;
        }

        default: {
          const exhaustive: never = selectedProvider.kind;
          throw new Error(`Unsupported provider type: ${String(exhaustive)}`);
        }
      }
    } catch (error) {
      if (
        error instanceof GenerationNoToolCallsError &&
        generationRetries < selectedProvider.maxGenerationRetries
      ) {
        generationRetries++;
        warning(
          `Generation produced no tool calls (retry ${generationRetries}/${selectedProvider.maxGenerationRetries})`,
          colors.keyword(agentSlug),
          colors.keyword(session.id()),
        );
        if (error.text !== undefined && error.text.length > 0) {
          session.pendingToolMessages.push({
            content: { content: error.text, type: "text" },
            role: "assistant",
          });
        }
        session.pendingToolMessages.push({
          content: {
            content:
              "You **must** now call the respond tool with the message content you tried to send. Plain text responses WILL fail. You can ONLY use `respond` to send text to the user.",
            type: "text",
          },
          role: "user",
        });
        continue;
      }
      throw error;
    }

    logUsage(agentSlug, session.id(), context.systemPrompt.length, usage);

    for (const msg of session.pendingToolMessages) {
      msg.timestamp ??= Date.now();
    }
    session.history.push(...session.pendingToolMessages);
    session.pendingToolMessages.length = 0;

    assistantMsg.timestamp = Date.now();
    session.history.push(assistantMsg);

    // Graceful stop: if the user requested a stop, filter out unexecuted tool
    // calls so history stays consistent (no orphaned tool_use blocks), then
    // exit the turn.
    if (session.stopRequested) {
      const nonToolContent = (
        Array.isArray(assistantMsg.content) ? assistantMsg.content : [assistantMsg.content]
      ).filter((content) => content.type !== "toolCall");

      if (nonToolContent.length > 0) {
        const lastIdx = session.history.length - 1;
        if (lastIdx >= 0) {
          session.history[lastIdx] = {
            ...assistantMsg,
            content: nonToolContent,
          };
        }
      } else {
        session.history.pop();
      }

      session.stopRequested = false;
      session.pendingToolMessages.length = 0;
      session.history = session.history.filter((msg) => {
        if (msg.role === "user" || msg.role === "assistant") {
          return msg.persist !== false;
        }
        return true;
      });
      debug("Turn stopped gracefully", colors.keyword(agentSlug), colors.keyword(session.id()));
      return;
    }

    const toolCalls = (
      Array.isArray(assistantMsg.content) ? assistantMsg.content : [assistantMsg.content]
    ).filter((it): it is ToolCallContent => it.type === "toolCall");

    let done = false;
    // Disable notifications are collected separately and pushed AFTER all
    // tool responses. Inserting a user message mid-sequence would split the
    // tool_result blocks across multiple user messages, violating the Anthropic
    // API requirement that every tool_use must have its tool_result in the
    // single immediately-following user message.
    const disableNotifications: string[] = [];

    for (const call of toolCalls) {
      const def = getToolRegistry()[call.name];
      if (def === undefined) {
        throw new Error(`Unknown tool: ${colors.keyword(call.name)}`);
      }

      debug("Tool call", colors.keyword(call.name), call);
      let result: Record<string, unknown> = {};
      try {
        result = await def.execute(call.input, ctx);
      } catch (error: unknown) {
        if (error instanceof vb.ValiError) {
          result = {
            error: error.message,
            issues: error.issues,
            success: false,
          };
        } else if (error instanceof ParseError) {
          result = {
            error: error.message,
            issues: error.issues,
            success: false,
          };
        } else if (error instanceof ToolError) {
          result = { error: error.message, hint: error.hint, success: false };
        } else {
          result = { error: sanitizeError(error, agentSlug), success: false };
        }
      }
      debug("Tool result", colors.keyword(call.name), result);

      // Track consecutive failures to catch looping behaviour.
      const toolFailed = typeof result["success"] === "boolean" && !result["success"];
      if (toolFailed) {
        const fails = (toolConsecutiveFailures.get(call.name) ?? 0) + 1;
        toolConsecutiveFailures.set(call.name, fails);
        if (
          fails >= toolFailThreshold &&
          !disabledTools.has(call.name) &&
          call.name !== "respond" &&
          call.name !== "no-response"
        ) {
          disabledTools.add(call.name);
          warning(
            `Disabling tool '${call.name}' after ${fails} consecutive failures (threshold: ${toolFailThreshold})`,
            colors.keyword(agentSlug),
            colors.keyword(session.id()),
          );
          disableNotifications.push(
            `The tool '${call.name}' has failed ${fails} times in a row and has been disabled for this turn. Please either stop trying, ask the user for more information, or do something else.`,
          );
        }
      } else {
        toolConsecutiveFailures.delete(call.name);
      }

      const response: ToolMessage = {
        content: {
          id: call.id,
          name: call.name,
          output: result,
          type: "toolResponse",
        },
        role: "toolResponse",
      };
      session.pendingToolMessages.push(response);

      if (
        (call.name === "respond" && result["success"] !== false && result["final"] !== false) ||
        call.name === "no-response"
      ) {
        done = true;
      }
    }

    if (disableNotifications.length > 0) {
      session.pendingToolMessages.push({
        content: { content: disableNotifications.join("\n\n"), type: "text" },
        role: "user",
      });
    }

    if (done) {
      // Apply sent message IDs from the channel handler to the assistant
      // history entry, so delete/reroll commands can look up by Discord ID.
      if (session.lastSentMessageIds !== undefined && session.lastSentMessageIds.length > 0) {
        const lastAssistant = session.history.findLast(
          (entry) => entry.role === "assistant" && entry.id === undefined,
        );
        if (lastAssistant !== undefined) {
          const [firstId, ...restIds] = session.lastSentMessageIds;
          lastAssistant.id = firstId;
          lastAssistant.messageIds = restIds.length > 0 ? session.lastSentMessageIds : undefined;
        }
        session.lastSentMessageIds = undefined;
      }

      for (const msg of session.pendingToolMessages) {
        msg.timestamp ??= Date.now();
      }
      session.history.push(...session.pendingToolMessages);
      session.pendingToolMessages.length = 0;

      // Prune ephemeral context (historical/reply-tree backfills) that we no
      // longer need to send now that the turn is complete.
      session.history = session.history.filter((msg) => {
        if (msg.role === "user" || msg.role === "assistant") {
          return msg.persist !== false;
        }
        return true;
      });

      debug("Turn end", colors.keyword(agentSlug), colors.keyword(session.id()));
      return;
    }
  }
}
