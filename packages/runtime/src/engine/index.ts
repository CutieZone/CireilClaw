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
import type { Context, UsageInfo } from "#engine/context.js";
import { GenerationNoToolCallsError, ToolError, ParseError } from "#engine/errors.js";
import { generate as generateAnthropicOauth } from "#engine/provider/anthropic-oauth.js";
import { generate as generateOai } from "#engine/provider/oai.js";
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

import type { AssistantMessage, ToolMessage } from "./message.js";
import { estimateSystemPrompt, pruneHistory, squashMessages } from "./prune.js";
import { buildSystemPrompt } from "./system-prompt.js";
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
      session.pendingToolMessages.push({ content: { content, type: "text" }, role: "user" });
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
    db: getDb(agentSlug),
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

  let generationRetries = 0;
  // Tracks consecutive failures per tool; disables the tool after hitting the threshold.
  const toolConsecutiveFailures = new Map<string, number>();
  const disabledTools = new Set<string>();

  const { toolFailThreshold } = modelCfg;

  for (;;) {
    // If tools or Discord queued images/videos, inject them as a user message
    // AFTER pending tool responses. The OAI API only allows images/video in
    // user-role messages, and they must come after the matching tool responses.

    // Deduplicate pending images by blake3 hash
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
      const media = [...session.pendingImages.splice(0), ...session.pendingVideos.splice(0)];
      session.pendingToolMessages.push({ content: media, role: "user" });
    }

    const prompt = await buildSystemPrompt(agentSlug, session, capabilities, conditions);

    const { modifiedHistory, newCursor } = pruneHistory(
      session.history,
      session.historyCursor,
      selectedProvider.maxTurns,
      modelCfg.contextWindow,
      modelCfg.contextBudget ?? 0.6,
      modelCfg.contextHardBudget ?? 0.85,
      estimateSystemPrompt(prompt),
    );
    session.history = modifiedHistory;
    session.historyCursor = newCursor;

    const visibleHistory = session.history.slice(session.historyCursor);
    const messages = squashMessages([...visibleHistory, ...session.pendingToolMessages]);

    // Blind models don't receive image/video blocks, but they still see attachment
    // metadata via Discord's <attachment> tags and can choose to download them.
    const filteredMessages = stripMediaForModel(
      messages,
      modelCfg.supportsVision,
      modelCfg.supportsVideo,
    );

    // Append an ephemeral date reminder so the LLM always sees the current time
    // at the very end of context, preventing date hallucination from stale history.
    filteredMessages.push({
      content: { content: `Current date: ${await formatDate()}`, type: "text" },
      role: "user",
    });

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
              useToolChoiceAuto: selectedProvider.useToolChoiceAuto,
            },
          ));
          break;
        }

        case "anthropic-oauth": {
          ({ message: assistantMsg, usage } = await generateAnthropicOauth(
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

        default: {
          const _exhaustive: never = selectedProvider.kind;
          throw new Error(`Unsupported provider type: ${String(_exhaustive)}`);
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
          content: { content: "Now use your tools to properly respond.", type: "text" },
          role: "user",
        });
        continue;
      }
      throw error;
    }

    logUsage(agentSlug, session.id(), context.systemPrompt.length, usage);

    // Pending messages have been sent to the API in this call — commit them to history.
    for (const msg of session.pendingToolMessages) {
      msg.timestamp ??= Date.now();
    }
    session.history.push(...session.pendingToolMessages);
    session.pendingToolMessages.length = 0;

    assistantMsg.timestamp = Date.now();
    session.history.push(assistantMsg);

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
          result = { error: error.message, issues: error.issues, success: false };
        } else if (error instanceof ParseError) {
          result = { error: error.message, issues: error.issues, success: false };
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
      // Prune: the respond tool's own response is the last thing in pending — flush it.
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
