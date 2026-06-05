import type { Agent } from "#agent/index.js";

export class Harness {
  private static instance: Harness | undefined;

  public readonly agents: Map<string, Agent>;

  private constructor(agents: Map<string, Agent>) {
    this.agents = agents;
  }

  public static init(agents: Map<string, Agent>): Harness {
    Harness.instance = new Harness(agents);
    return Harness.instance;
  }

  public static get(): Harness {
    if (Harness.instance === undefined) {
      throw new Error("Harness.get() called before Harness.init()");
    }
    return Harness.instance;
  }

  public async startSchedulers(): Promise<void> {
    for (const agent of this.agents.values()) {
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
