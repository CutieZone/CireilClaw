import { readFile, stat } from "node:fs/promises";

import { loadTools } from "$/config/index.js";
import type { ConditionsConfig } from "$/config/index.js";
import type { ApiKey, EngineConfig, EngineOverride, EngineOverrides } from "$/config/schemas.js";
import { getDb } from "$/db/index.js";
import type { ToolCallContent } from "$/engine/content.js";
import type { Context, UsageInfo } from "$/engine/context.js";
import { GenerationNoToolCallsError, ToolError, ParseError } from "$/engine/errors.js";
import type { AssistantMessage, Message, ToolMessage } from "$/engine/message.js";
import { generate as generateAnthropicOauth } from "$/engine/provider/anthropic-oauth/index.js";
import { ProviderKindSchema } from "$/engine/provider/index.js";
import { generate } from "$/engine/provider/oai.js";
import type { Tool } from "$/engine/tool.js";
import type { ToolContext } from "$/engine/tools/tool-def.js";
import type {
  ChannelCapabilities,
  ChannelResolution,
  HistoryDirection,
  HistoryMessage,
} from "$/harness/channel-handler.js";
import { DiscordSession, InternalSession, MatrixSession } from "$/harness/session.js";
import type { Session } from "$/harness/session.js";
import colors from "$/output/colors.js";
import { debug, warning } from "$/output/log.js";
import { formatDate } from "$/util/date.js";
import type { KeyPool } from "$/util/key-pool.js";
import { KeyPool as KeyPoolClass, KeyPoolManager } from "$/util/key-pool.js";
import {
  loadBlocks,
  loadBaseInstructions,
  loadConditionalBlocks,
  loadSkills,
} from "$/util/load.js";
import { sandboxToReal, sanitizeError } from "$/util/paths.js";
import * as vb from "valibot";

import { toolRegistry } from "./tools/index.js";

function truncateToTurns(messages: Message[], maxTurns: number): Message[] {
  const turns: Message[][] = [];

  for (const msg of messages) {
    // Start a new turn on user messages, or if we're just beginning
    if (msg.role === "user" || turns.length === 0) {
      turns.push([msg]);
    } else {
      // Associate with the current turn (assistant or toolResponse)
      const currentTurn = turns.at(-1);
      if (currentTurn !== undefined) {
        currentTurn.push(msg);
      }
    }
  }

  // Keep only the last maxTurns
  const truncated = turns.slice(-maxTurns);
  return truncated.flat();
}

function squashMessages(messages: Message[]): Message[] {
  const result: Message[] = [];

  for (const msg of messages) {
    const last = result.at(-1);

    if (last?.role === "user" && msg.role === "user") {
      const prev = Array.isArray(last.content) ? last.content : [last.content];
      const cur = Array.isArray(msg.content) ? msg.content : [msg.content];
      result.splice(-1, 1, { content: [...prev, ...cur], role: "user" });
    } else if (last?.role === "assistant" && msg.role === "assistant") {
      const prev = Array.isArray(last.content) ? last.content : [last.content];
      const cur = Array.isArray(msg.content) ? msg.content : [msg.content];
      result.splice(-1, 1, { content: [...prev, ...cur], role: "assistant" });
    } else {
      result.push(msg);
    }
  }

  return result;
}

const NO_CAPABILITIES: ChannelCapabilities = {
  supportsAttachments: false,
  supportsDownloadAttachments: false,
  supportsReactions: false,
};

async function buildSystemPrompt(
  agentSlug: string,
  session: Session,
  capabilities: ChannelCapabilities,
  conditions?: ConditionsConfig,
): Promise<string> {
  const baseInstructions = await loadBaseInstructions(agentSlug);
  const blocks = await loadBlocks(agentSlug);
  const conditionalBlocks = conditions
    ? await loadConditionalBlocks(agentSlug, conditions, session)
    : [];

  const lines: string[] = [
    "<base_instructions>",
    baseInstructions.trim(),
    "</base_instructions>",
    "<metadata>",
    `The current system date is: ${await formatDate()}`,
    `The current session is on the platform: ${session.channel}`,
  ];

  if (session.channel === "discord") {
    lines.push(`The channel id is: ${session.channelId}`);
    if (session.guildId === undefined) {
      lines.push("SFW/NSFW depending on the user");
    } else {
      lines.push(`This is considered a ${session.isNsfw ? "NSFW" : "SFW"} session`);
    }
  } else if (session instanceof InternalSession) {
    lines.push(`This is an internal cron session (job ID: ${session.jobId})`);
  } else if (session.channel === "internal") {
    lines.push("This is a persistent internal session");
  } else if (session.channel === "tui") {
    lines.push("This is a TUI session with your person. SFW/NSFW depending on their preferences.");
  } else {
    throw new Error(`Unimplemented channel: ${session.channel}`);
  }

  lines.push(
    `- reactions supported: ${capabilities.supportsReactions}`,
    `- file attachments in respond supported: ${capabilities.supportsAttachments}`,
    `- attachment downloads supported: ${capabilities.supportsDownloadAttachments}`,
  );

  lines.push(
    "</metadata>",
    "<memory_blocks>",
    "The following blocks are engaged in your memory:",
    "",
  );

  for (const [key, value] of Object.entries(blocks)) {
    lines.push(
      `<${key}>`,
      "<description>",
      value.description.trim(),
      "</description>",
      "<metadata>",
      `- chars_current: ${value.metadata.chars_current}`,
      `- file_path: ${value.filePath}`,
      "</metadata>",
      "<content>",
      value.content.trim(),
      "</content>",
      `</${key}>`,
      "",
    );
  }

  // Add conditional blocks if any were loaded
  for (const block of conditionalBlocks) {
    lines.push(
      `<${block.label}>`,
      "<description>",
      block.description.trim(),
      "</description>",
      "<metadata>",
      `- chars_current: ${block.metadata.chars_current}`,
      `- file_path: ${block.filePath}`,
      "- conditional: true",
      "</metadata>",
      "<content>",
      block.content.trim(),
      "</content>",
      `</${block.label}>`,
      "",
    );
  }

  lines.push("</memory_blocks>");

  const skills = await loadSkills(agentSlug);

  if (skills.length > 0) {
    lines.push("<skills>");

    for (const skill of skills) {
      lines.push(
        `<skill slug="${skill.slug}">`,
        `<description>${skill.description}</description>`,
        `</skill>`,
      );
    }

    lines.push("</skills>");
  }

  if (session.openedFiles.size > 0) {
    lines.push("<opened_files>", "These are your currently open files:", "");

    for (const file of session.openedFiles) {
      const realPath = sandboxToReal(file, agentSlug);
      const content = await readFile(realPath, "utf8");
      const { size } = await stat(realPath);

      lines.push(`<file path="${file}" size="${size}">`, content, "</file>", "");
    }

    lines.push("</opened_files>");
  }

  return lines.join("\n");
}

async function buildTools(agentSlug: string, _session: Session): Promise<Tool[]> {
  const cfg = Object.entries(await loadTools(agentSlug));

  const tools: Tool[] = [];

  for (const [tool, setting] of cfg) {
    const def = toolRegistry[tool];

    if (def === undefined) {
      throw new Error(`Tried to enable invalid tool ${colors.keyword(tool)}: does not exist`);
    }

    const enabledByValue = typeof setting === "boolean" && setting;
    const enabledByKey =
      typeof setting === "object" &&
      "enabled" in setting &&
      typeof setting.enabled === "boolean" &&
      setting.enabled;

    if (!(enabledByValue || enabledByKey)) {
      continue;
    }

    tools.push(def);
  }

  return tools;
}

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

export class Engine {
  private readonly _apiKey: ApiKey;
  private readonly _apiKeyPool: KeyPoolClass;
  private readonly _apiBase: string;
  private readonly _model: string;
  private readonly _provider: string;
  private readonly _overrides: EngineOverrides;
  private readonly _maxTurns: number;
  private readonly _maxGenerationRetries: number;
  private readonly _toolFailThreshold: number;

  constructor(cfg: EngineConfig) {
    this._apiKey = cfg.apiKey;
    this._apiKeyPool = new KeyPoolClass(cfg.apiKey);
    this._apiBase = cfg.apiBase;
    this._maxGenerationRetries = cfg.maxGenerationRetries;
    this._maxTurns = cfg.maxTurns;
    this._model = cfg.model;
    this._provider = cfg.provider;
    this._overrides = cfg.channel;
    this._toolFailThreshold = cfg.toolFailThreshold;
  }

  get apiBase(): string {
    return this._apiBase;
  }

  get apiKey(): ApiKey {
    return this._apiKey;
  }

  get apiKeyPool(): KeyPoolClass {
    return this._apiKeyPool;
  }

  get model(): string {
    return this._model;
  }

  get provider(): string {
    return this._provider;
  }

  get overrides(): EngineOverrides {
    return this._overrides;
  }

  get maxGenerationRetries(): number {
    return this._maxGenerationRetries;
  }

  get maxTurns(): number {
    return this._maxTurns;
  }

  get toolFailThreshold(): number {
    return this._toolFailThreshold;
  }

  /** Create a new Engine based on this one, with select fields replaced. */
  derive(partial: Partial<EngineConfig>): Engine {
    return new Engine({
      apiBase: partial.apiBase ?? this._apiBase,
      apiKey: partial.apiKey ?? this._apiKey,
      channel: partial.channel ?? this._overrides,
      maxGenerationRetries: partial.maxGenerationRetries ?? this._maxGenerationRetries,
      maxTurns: partial.maxTurns ?? this._maxTurns,
      model: partial.model ?? this._model,
      provider: partial.provider ?? this._provider,
      toolFailThreshold: partial.toolFailThreshold ?? this._toolFailThreshold,
    });
  }

  /**
   * Resolve an override's apiKey to a KeyPool, or return the default pool.
   */
  private _resolveKeyPool(override: EngineOverride | undefined): KeyPoolClass {
    if (override?.apiKey !== undefined) {
      return KeyPoolManager.getPool(override.apiKey);
    }
    return this._apiKeyPool;
  }

  static resolveOverride(session: Session, overrides: EngineOverrides): EngineOverride | undefined {
    if (session instanceof DiscordSession && session.guildId !== undefined) {
      return overrides.discord?.guild?.[session.guildId];
    } else if (session instanceof MatrixSession) {
      return overrides.matrix?.[session.roomId];
    }

    return undefined;
  }

  async runTurn(
    session: Session,
    agentSlug: string,
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
  ): Promise<void> {
    const tools = await buildTools(agentSlug, session);
    const ctx: ToolContext = {
      agentSlug,
      conditions,
      db: getDb(agentSlug),
      downloadAttachments,
      fetchHistory,
      react,
      resolveChannel:
        resolveChannel ??
        // oxlint-disable-next-line typescript/require-await
        (async () => {
          const error = { error: "channel resolution not supported" };
          return error;
        }),
      send,
      sendTo,
      session,
    };

    debug("Turn start", colors.keyword(agentSlug), colors.keyword(session.id()));

    let generationRetries = 0;
    // Tracks consecutive failures per tool; disables the tool after hitting the threshold.
    const toolConsecutiveFailures = new Map<string, number>();
    const disabledTools = new Set<string>();

    const override = Engine.resolveOverride(session, this._overrides);

    const effectiveKeyPool: KeyPool = this._resolveKeyPool(override);
    const effectiveApiBase: string = override?.apiBase ?? this._apiBase;
    const effectiveModel: string = override?.model ?? this._model;
    const effectiveProvider = vb.parse(ProviderKindSchema, override?.provider ?? this._provider);

    if (session.history.length > this._maxTurns * 3) {
      debug(
        "Truncating history",
        colors.number(session.history.length),
        "messages to last",
        colors.number(this._maxTurns),
        "turns",
      );
    }

    for (;;) {
      // If tools queued images in the previous iteration, inject them as a user
      // message AFTER pending tool responses. The OAI API only allows images in
      // user-role messages, and they must come after the matching tool responses.
      if (session.pendingImages.length > 0) {
        const images = session.pendingImages.splice(0);
        session.pendingToolMessages.push({ content: images, role: "user" });
      }

      const prompt = await buildSystemPrompt(agentSlug, session, capabilities, conditions);
      const history = truncateToTurns(session.history, this._maxTurns);
      const messages = squashMessages([...history, ...session.pendingToolMessages]);
      const activeTools = tools.filter((tool) => !disabledTools.has(tool.name));

      const context: Context = {
        messages,
        sessionId: session.id(),
        systemPrompt: prompt,
        tools: activeTools,
      };

      // oxlint-disable-next-line init-declarations
      let assistantMsg: AssistantMessage;
      let usage: UsageInfo | undefined = undefined;

      try {
        switch (effectiveProvider) {
          case "openai": {
            ({ message: assistantMsg, usage } = await generate(
              context,
              effectiveApiBase,
              effectiveKeyPool,
              effectiveModel,
            ));
            break;
          }

          case "anthropic-oauth": {
            ({ message: assistantMsg, usage } = await generateAnthropicOauth(
              context,
              effectiveKeyPool,
              effectiveModel,
            ));
            break;
          }

          default: {
            const _exhaustive: never = effectiveProvider;
            throw new Error(`Unsupported provider type: ${String(_exhaustive)}`);
          }
        }
      } catch (error) {
        if (
          error instanceof GenerationNoToolCallsError &&
          generationRetries < this._maxGenerationRetries
        ) {
          generationRetries++;
          warning(
            `Generation produced no tool calls (retry ${generationRetries}/${this._maxGenerationRetries})`,
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
        const def = toolRegistry[call.name];
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
          if (fails >= this._toolFailThreshold && !disabledTools.has(call.name)) {
            disabledTools.add(call.name);
            warning(
              `Disabling tool '${call.name}' after ${fails} consecutive failures (threshold: ${this._toolFailThreshold})`,
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

        if ((call.name === "respond" && result["final"] !== false) || call.name === "no-response") {
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
        debug("Turn end", colors.keyword(agentSlug), colors.keyword(session.id()));
        return;
      }
    }
  }
}
