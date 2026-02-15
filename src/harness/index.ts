import type { Agent } from "$/agent/index.js";
import type { Watchers } from "$/config/index.js";
import type { ChannelType, Session } from "$/harness/session.js";

type SendFn = (session: Session, content: string) => Promise<void>;

export class Harness {
  private static _instance: Harness | undefined;

  private _agents: Map<string, Agent>;
  private _watcher: Watchers;
  private _sendHandlers = new Map<ChannelType, SendFn>();

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

  registerSend(channel: ChannelType, fn: SendFn): void {
    this._sendHandlers.set(channel, fn);
  }

  async send(session: Session, content: string): Promise<void> {
    const fn = this._sendHandlers.get(session.channel);
    if (fn === undefined) {
      throw new Error(`No send handler registered for channel: ${session.channel}`);
    }
    await fn(session, content);
  }
}
