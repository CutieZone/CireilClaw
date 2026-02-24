import type { EngineConfig } from "$/config/schemas.js";
import { Engine } from "$/engine/index.js";
import type { Session } from "$/harness/session.js";

type SendFn = (session: Session, content: string) => Promise<void>;
type ReactFn = (session: Session, emoji: string, messageId?: string) => Promise<void>;

export class Agent {
  private _engine: Engine;
  private readonly _slug: string;
  private readonly _sessions: Map<string, Session>;
  private _send: SendFn | undefined = undefined;
  private _react: ReactFn | undefined = undefined;

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

  registerSend(fn: SendFn): void {
    this._send = fn;
  }

  registerReact(fn: ReactFn): void {
    this._react = fn;
  }

  async send(session: Session, content: string): Promise<void> {
    // Allow the session to intercept and optionally suppress delivery.
    if (session.sendFilter !== undefined && !session.sendFilter(content)) {
      return;
    }

    if (this._send === undefined) {
      throw new Error(`Agent ${this._slug} has no send handler registered`);
    }
    await this._send(session, content);
  }

  async runTurn(session: Session): Promise<void> {
    const send = async (content: string): Promise<void> => {
      await this.send(session, content);
    };
    const react =
      this._react === undefined
        ? undefined
        : async (emoji: string, messageId?: string): Promise<void> => {
            await this._react?.(session, emoji, messageId);
          };
    await this._engine.runTurn(session, this._slug, send, react);
  }
}
