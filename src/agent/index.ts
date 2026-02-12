import type { EngineConfig } from "$/config/index.js";

import { Engine } from "$/engine/index.js";

export class Agent {
  private _engine: Engine;
  private _slug: string;

  constructor(slug: string, cfg: EngineConfig) {
    this._engine = new Engine(cfg);
    this._slug = slug;
  }

  get engine(): Engine {
    return this._engine;
  }

  updateEngine(cfg: EngineConfig): void {
    this._engine = new Engine(cfg);
  }

  get slug(): string {
    return this._slug;
  }
}
