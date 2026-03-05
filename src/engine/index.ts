import { readFile, stat } from "node:fs/promises";

import { loadTools } from "$/config/index.js";
import type { ApiKey, EngineConfig, EngineOverride, EngineOverrides } from "$/config/schemas.js";
import type { ToolCallContent } from "$/engine/content.js";
import type { Context, UsageInfo } from "$/engine/context.js";
import type { AssistantMessage, Message, ToolMessage } from "$/engine/message.js";
import { generate as generateAnthropicOauth } from "$/engine/provider/anthropic-oauth/index.js";
import type { ProviderKind } from "$/engine/provider/index.js";
import { generate } from "$/engine/provider/oai.js";
import type { Tool } from "$/engine/tool.js";
import type { ToolContext } from "$/engine/tools/tool-def.js";
import { DiscordSession, MatrixSession } from "$/harness/session.js";
import type { Session } from "$/harness/session.js";
import colors from "$/output/colors.js";
import { debug } from "$/output/log.js";
import type { KeyPool } from "$/util/key-pool.js";
import { KeyPool as KeyPoolClass } from "$/util/key-pool.js";
import { loadBlocks, loadBaseInstructions, loadSkills } from "$/util/load.js";
import { sandboxToReal } from "$/util/paths.js";

import { toolRegistry } from "./tools/index.js";

const MAX_TURNS = 30;

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

async function buildSystemPrompt(agentSlug: string, session: Session): Promise<string> {
  const baseInstructions = await loadBaseInstructions(agentSlug);
  const blocks = await loadBlocks(agentSlug);

  const lines: string[] = [
    "<base_instructions>",
    baseInstructions.trim(),
    "</base_instructions>",
    "<metadata>",
    `The current system date is: ${new Date().toISOString()}`,
    `The current session is on the platform: ${session.channel}`,
  ];

  if (session.channel === "discord") {
    lines.push(`The channel id is: ${session.channelId}`);
    if (session.guildId === undefined) {
      lines.push("SFW/NSFW depending on the user");
    } else {
      lines.push(`This is considered a ${session.isNsfw ? "NSFW" : "SFW"} session`);
    }
  } else if (session.channel === "tui") {
    lines.push("This is a local terminal (TUI) session. The user is interacting directly via the terminal.");
  } else if (session.channel === "internal") {
    lines.push(`This is an internal cron session (job ID: ${session.jobId})`);
  } else {
    throw new Error(`Unimplemented channel: ${session.channel}`);
  }

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

  lines.push("</memory_blocks>");

  const skills = await loadSkills(agentSlug);

  if (skills.length > 0) {
    lines.push("<skills>");

    for (const skill of skills) {
      lines.push(
        `<skill slug="${skill.slug}">`,
        `<summary>${skill.summary}</summary>`,
        `<when>${skill.whenToUse}</when>`,
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
  private readonly _maxTokens: number | undefined;
  private readonly _temperature: number | undefined;

  constructor(cfg: EngineConfig) {
    this._apiKey = cfg.apiKey;
    this._apiKeyPool = new KeyPoolClass(cfg.apiKey);
    this._apiBase = cfg.apiBase;
    this._model = cfg.model;
    this._provider = cfg.provider;
    this._overrides = cfg.channel;
    this._maxTokens = cfg.maxTokens;
    this._temperature = cfg.temperature;
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

  /**
   * Resolve an override's apiKey to a KeyPool, or return the default pool.
   */
  private _resolveKeyPool(override: EngineOverride | undefined): KeyPoolClass {
    if (override?.apiKey !== undefined) {
      return new KeyPoolClass(override.apiKey);
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
    react?: (emoji: string, messageId?: string) => Promise<void>,
    downloadAttachments?: (messageId: string) => Promise<{ filename: string; data: Buffer }[]>,
  ): Promise<void> {
    const allTools = await buildTools(agentSlug, session);
    // Strip tools whose capabilities are absent on this channel to save tokens.
    const tools = allTools.filter((tool) => {
      if (tool.name === "download-attachments" && downloadAttachments === undefined) {
        return false;
      }
      if (tool.name === "react" && react === undefined) {
        return false;
      }
      return true;
    });
    const ctx: ToolContext = {
      agentSlug,
      downloadAttachments,
      react,
      send,
      session,
    };

    debug("Turn start", colors.keyword(agentSlug), colors.keyword(session.id()));

    const override = Engine.resolveOverride(session, this._overrides);

    const effectiveKeyPool: KeyPool = this._resolveKeyPool(override);
    const effectiveApiBase: string = override?.apiBase ?? this._apiBase;
    const effectiveModel: string = override?.model ?? this._model;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const effectiveProvider: ProviderKind = (override?.provider ?? this._provider) as ProviderKind;

    if (session.history.length > MAX_TURNS * 3) {
      debug(
        "Truncating history",
        colors.number(session.history.length),
        "messages to last",
        colors.number(MAX_TURNS),
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

      const prompt = await buildSystemPrompt(agentSlug, session);
      const history = truncateToTurns(session.history, MAX_TURNS);
      const messages = squashMessages([...history, ...session.pendingToolMessages]);

      const context: Context = {
        messages,
        sessionId: session.id(),
        systemPrompt: prompt,
        tools,
      };

      // oxlint-disable-next-line init-declarations
      let assistantMsg: AssistantMessage;
      let usage: UsageInfo | undefined = undefined;
      switch (effectiveProvider) {
        case "openai": {
          ({ message: assistantMsg, usage } = await generate(
            context,
            effectiveApiBase,
            effectiveKeyPool,
            effectiveModel,
            this._maxTokens,
            this._temperature,
          ));
          break;
        }

        case "anthropic-oauth": {
          ({ message: assistantMsg, usage } = await generateAnthropicOauth(
            context,
            effectiveKeyPool,
            effectiveModel,
            this._maxTokens,
            this._temperature,
          ));
          break;
        }

        default: {
          const _exhaustive: never = effectiveProvider;
          throw new Error(`Unsupported provider type: ${String(_exhaustive)}`);
        }
      }

      logUsage(agentSlug, session.id(), context.systemPrompt.length, usage);

      // Pending messages have been sent to the API in this call — commit them to history.
      session.history.push(...session.pendingToolMessages);
      session.pendingToolMessages.length = 0;

      session.history.push(assistantMsg);

      const toolCalls = (
        Array.isArray(assistantMsg.content) ? assistantMsg.content : [assistantMsg.content]
      ).filter((it): it is ToolCallContent => it.type === "toolCall");

      let done = false;

      for (const call of toolCalls) {
        const def = toolRegistry[call.name];
        if (def === undefined) {
          throw new Error(`Unknown tool: ${colors.keyword(call.name)}`);
        }

        debug("Tool call", colors.keyword(call.name), call);
        const result = await def.execute(call.input, ctx);
        debug("Tool result", colors.keyword(call.name), result);

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

      if (done) {
        // Prune: the respond tool's own response is the last thing in pending — flush it.
        session.history.push(...session.pendingToolMessages);
        session.pendingToolMessages.length = 0;
        debug("Turn end", colors.keyword(agentSlug), colors.keyword(session.id()));
        return;
      }
    }
  }
}
