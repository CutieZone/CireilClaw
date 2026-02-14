import type { EngineConfig } from "$/config/index.js";
import type { Session } from "$/harness/session.js";

import { Engine } from "$/engine/index.js";

export class Agent {
  private _engine: Engine;
  private _slug: string;
  private _sessions: Map<string, Session>;

  constructor(slug: string, cfg: EngineConfig, sessions: Map<string, Session>) {
    this._engine = new Engine(cfg);
    this._slug = slug;
    this._sessions = sessions;
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

  get sessions(): Map<string, Session> {
    return this._sessions;
  }
}
