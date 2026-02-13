import type { EngineConfig } from "$/config/index.js";
import type { Context } from "$/engine/context.js";
import type { Message } from "$/engine/message.js";
import type { ProviderKind } from "$/engine/provider/index.js";
import type { Tool } from "$/engine/tool.js";
import type { Session } from "$/harness/session.js";

import { generate } from "$/engine/provider/oai.js";

// oxlint-disable-next-line typescript/require-await
async function buildSystemPrompt(_session: Session): Promise<string> {
  throw new Error("unimplemented");
}

// oxlint-disable-next-line typescript/require-await
async function buildTools(_session: Session): Promise<Tool[]> {
  throw new Error("unimplemented");
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

  async generate(session: Session): Promise<Message> {
    const prompt = await buildSystemPrompt(session);

    const context: Context = {
      messages: session.history,
      sessionId: session.id(),
      systemPrompt: prompt,
      tools: await buildTools(session),
    };

    let resp: Message | undefined = undefined;

    switch (this._type) {
      case "openai":
        resp = await generate(context, this.apiBase, this._apiKey, this.model);
        break;

      default:
        throw new Error("unimplemented");
    }

    throw new Error("unimplemented");
  }
}
