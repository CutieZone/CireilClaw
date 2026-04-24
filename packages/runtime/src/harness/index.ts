import type { Agent } from "$/agent/index.js";

export class Harness {
  private static _instance: Harness | undefined;

  private readonly _agents: Map<string, Agent>;

  private constructor(agents: Map<string, Agent>) {
    this._agents = agents;
  }

  public static init(agents: Map<string, Agent>): Harness {
    Harness._instance = new Harness(agents);
    return Harness._instance;
  }

  public static get(): Harness {
    if (Harness._instance === undefined) {
      throw new Error("Harness.get() called before Harness.init()");
    }
    return Harness._instance;
  }

  public get agents(): Map<string, Agent> {
    return this._agents;
  }

  public async startSchedulers(): Promise<void> {
    for (const agent of this._agents.values()) {
      await agent.scheduler?.start();
    }
  }

  public stopSchedulers(): void {
    for (const agent of this.agents.values()) {
      agent.scheduler?.stop();
    }
  }

  public async reloadScheduler(agentSlug: string): Promise<void> {
    const scheduler = this.agents.get(agentSlug)?.scheduler;
    if (scheduler !== undefined) {
      await scheduler.reload();
    }
  }
}
