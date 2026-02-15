import type { EngineConfig } from "$/config/index.js";
import type { ToolCallContent } from "$/engine/content.js";
import type { Context } from "$/engine/context.js";
import type { AssistantMessage, Message, ToolMessage } from "$/engine/message.js";
import type { ProviderKind } from "$/engine/provider/index.js";
import type { Tool } from "$/engine/tool.js";
import type { ToolContext } from "$/engine/tools/tool-def.js";
import type { Session } from "$/harness/session.js";

import { loadTools } from "$/config/index.js";
import { generate } from "$/engine/provider/oai.js";
import colors from "$/output/colors.js";
import { debug } from "$/output/log.js";
import { loadBlocks, loadBaseInstructions } from "$/util/load.js";
import { sandboxToReal } from "$/util/paths.js";
import { readFile, stat } from "node:fs/promises";

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
    lines.push(
      `The channel id is: ${session.channelId}`,
      `The guild id is: ${session.guildId}`,
      `This is considered a ${session.isNsfw === true ? "NSFW" : "SFW"} session`,
    );
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

export class Engine {
  private _apiKey: string;
  private _apiBase: string;
  private _model: string;
  private _type: ProviderKind;

  constructor(cfg: EngineConfig) {
    this._apiKey = cfg.apiKey;
    this._apiBase = cfg.apiBase;
    this._model = cfg.model;
    this._type = "openai";
  }

  get apiBase(): string {
    return this._apiBase;
  }

  get model(): string {
    return this._model;
  }

  async runTurn(session: Session, agentSlug: string): Promise<void> {
    const tools = await buildTools(agentSlug, session);
    const ctx: ToolContext = { agentSlug, session };

    debug("Turn start", colors.keyword(agentSlug), colors.keyword(session.id()));

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
      const prompt = await buildSystemPrompt(agentSlug, session);
      const history = truncateToTurns(session.history, MAX_TURNS);
      const messages = squashMessages([...history, ...session.pendingToolMessages]);

      const context: Context = {
        messages,
        sessionId: session.id(),
        systemPrompt: prompt,
        tools,
      };

      let assistantMsg: AssistantMessage | undefined = undefined;
      switch (this._type) {
        case "openai":
          assistantMsg = await generate(context, this._apiBase, this._apiKey, this._model);
          break;

        default: {
          const _exhaustive: never = this._type;
          throw new Error(`Unsupported provider type: ${String(_exhaustive)}`);
        }
      }

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

        debug("Tool call", colors.keyword(call.name));
        const result = await def.execute(call.input, ctx);
        debug("Tool result", colors.keyword(call.name));

        const response: ToolMessage = {
          content: { id: call.id, name: call.name, output: result, type: "toolResponse" },
          role: "toolResponse",
        };
        session.pendingToolMessages.push(response);

        if (call.name === "respond" && result["final"] !== false) {
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
