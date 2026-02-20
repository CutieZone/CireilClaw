import type { Agent } from "$/agent/index.js";
import type { Watchers } from "$/config/schemas.js";
import { Scheduler } from "$/scheduler/index.js";

export class Harness {
  private static _instance: Harness | undefined;

  private readonly _agents: Map<string, Agent>;
  private readonly _watcher: Watchers;
  private readonly _schedulers = new Map<string, Scheduler>();

  private constructor(agents: Map<string, Agent>, watcher: Watchers) {
    this._agents = agents;
    this._watcher = watcher;
  }

  static init(agents: Map<string, Agent>, watcher: Watchers): Harness {
    Harness._instance = new Harness(agents, watcher);
    return Harness._instance;
  }

  static get(): Harness {
    if (Harness._instance === undefined) {
      throw new Error("Harness.get() called before Harness.init()");
    }
    return Harness._instance;
  }

  get agents(): Map<string, Agent> {
    return this._agents;
  }

  get watcher(): Watchers {
    return this._watcher;
  }

  async startSchedulers(signal: AbortSignal): Promise<void> {
    for (const agent of this._agents.values()) {
      const scheduler = new Scheduler(agent, signal);
      this._schedulers.set(agent.slug, scheduler);
      await scheduler.start();
    }
  }

  stopSchedulers(): void {
    for (const scheduler of this._schedulers.values()) {
      scheduler.stop();
    }
    this._schedulers.clear();
  }

  async reloadScheduler(agentSlug: string): Promise<void> {
    const scheduler = this._schedulers.get(agentSlug);
    if (scheduler !== undefined) {
      await scheduler.reload();
    }
  }

  getScheduler(agentSlug: string): Scheduler | undefined {
    return this._schedulers.get(agentSlug);
  }
}
