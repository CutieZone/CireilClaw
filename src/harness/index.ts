import type { Agent } from "$/agent/index.js";
import type { Watchers } from "$/config/index.js";

export class Harness {
  private _agents: Map<string, Agent>;
  private _watcher: Watchers;

  constructor(agents: Map<string, Agent>, watcher: Watchers) {
    this._agents = agents;
    this._watcher = watcher;
  }

  get agents(): Map<string, Agent> {
    return this._agents;
  }

  get watcher(): Watchers {
    return this._watcher;
  }
}
