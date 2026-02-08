import type { EngineConfig } from "$/config/index.js";

export class Engine {
  private _apiKey: string;
  private _apiBase: string;
  private _model: string;

  constructor(cfg: EngineConfig) {
    this._apiKey = cfg.apiKey;
    this._apiBase = cfg.apiBase;
    this._model = cfg.model;
  }

  get apiBase(): string {
    return this._apiBase;
  }

  get model(): string {
    return this._model;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Token ${this._apiKey}`,
    };
  }
}
