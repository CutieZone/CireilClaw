import type { EngineConfig } from "$/config/index.js";
import type { Context } from "$/engine/context.js";
import type { Message } from "$/engine/message.js";
import type { ProviderKind } from "$/engine/provider/index.js";
import type { Tool } from "$/engine/tool.js";
import type { Session } from "$/harness/session.js";

import { loadTools } from "$/config/index.js";
import { generate } from "$/engine/provider/oai.js";
import colors from "$/output/colors.js";
import { loadBlocks, loadBaseInstructions } from "$/util/load.js";
import { sandboxToReal } from "$/util/paths.js";
import { readFile, stat } from "node:fs/promises";

import { toolRegistry } from "./tools/index.js";

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
      const realPath = sandboxToReal(file);
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

  for (const [tool, enabled] of cfg) {
    const def = toolRegistry[tool];

    if (def === undefined) {
      throw new Error(`Tried to enable invalid tool ${colors.keyword(tool)}: does not exist`);
    }

    if (!enabled) {
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

  async generate(session: Session, agentSlug: string): Promise<Message> {
    const prompt = await buildSystemPrompt(agentSlug, session);

    const context: Context = {
      messages: session.history,
      sessionId: session.id(),
      systemPrompt: prompt,
      tools: await buildTools(agentSlug, session),
    };

    switch (this._type) {
      case "openai":
        return generate(context, this.apiBase, this._apiKey, this.model);

      default: {
        const _exhaustive: never = this._type;
        throw new Error(`Unsupported provider type: ${String(_exhaustive)}`);
      }
    }
  }
}
