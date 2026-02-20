import type { Agent } from "$/agent/index.js";
import type { Watchers } from "$/config/schemas.js";
import type { ChannelType, Session } from "$/harness/session.js";
import { debug } from "$/output/log.js";
import { Scheduler } from "$/scheduler/index.js";

type SendFn = (session: Session, content: string) => Promise<void>;

export class Harness {
  private static _instance: Harness | undefined;

  private readonly _agents: Map<string, Agent>;
  private readonly _watcher: Watchers;
  private readonly _sendHandlers = new Map<ChannelType, SendFn>();
  private readonly _schedulers = new Map<string, Scheduler>();

  private constructor(agents: Map<string, Agent>, watcher: Watchers) {
    this._agents = agents;
    this._watcher = watcher;

    // Internal sessions are ephemeral — their "sends" are either intercepted by
    // sendFilter or silently swallowed here.
    // oxlint-disable-next-line typescript/require-await
    this._sendHandlers.set("internal", async (_session, content) => {
      debug("Harness: internal session output (no delivery target):", content.slice(0, 80));
    });
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

  registerSend(channel: ChannelType, fn: SendFn): void {
    this._sendHandlers.set(channel, fn);
  }

  async send(session: Session, content: string): Promise<void> {
    // Allow the session to intercept and optionally suppress delivery.
    if (session.sendFilter !== undefined && !session.sendFilter(content)) {
      return;
    }

    const fn = this._sendHandlers.get(session.channel);
    if (fn === undefined) {
      throw new Error(`No send handler registered for channel: ${session.channel}`);
    }
    await fn(session, content);
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
