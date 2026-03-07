import type { EngineConfig } from "$/config/schemas.js";
import { Engine } from "$/engine/index.js";
import { MINIMAL_HANDLER } from "$/harness/channel-handler.js";
import type { ChannelHandler } from "$/harness/channel-handler.js";
import type { Session } from "$/harness/session.js";

export class Agent {
  private _engine: Engine;
  private readonly _slug: string;
  private readonly _sessions: Map<string, Session>;
  private readonly _channelHandlers = new Map<string, ChannelHandler>();

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

  registerChannel(channel: string, handler: ChannelHandler): void {
    this._channelHandlers.set(channel, handler);
  }

  private _getHandler(session: Session): ChannelHandler {
    return this._channelHandlers.get(session.channel) ?? MINIMAL_HANDLER;
  }

  async send(session: Session, content: string, attachments?: string[]): Promise<void> {
    // Allow the session to intercept and optionally suppress delivery.
    if (session.sendFilter !== undefined && !session.sendFilter(content)) {
      return;
    }

    const handler = this._getHandler(session);
    await handler.send(session, content, attachments);
  }

  async runTurn(session: Session): Promise<void> {
    const handler = this._getHandler(session);

    const send = async (content: string, attachments?: string[]): Promise<void> => {
      await this.send(session, content, attachments);
    };

    const react =
      handler.react === undefined
        ? undefined
        : async (emoji: string, messageId?: string): Promise<void> => {
            await handler.react?.(session, emoji, messageId);
          };

    const downloadAttachments =
      handler.downloadAttachments === undefined
        ? undefined
        : async (messageId: string): Promise<{ filename: string; data: Buffer }[]> => {
            const result = await handler.downloadAttachments?.(session, messageId);
            return result ?? [];
          };

    await this._engine.runTurn(
      session,
      this._slug,
      send,
      react,
      downloadAttachments,
      handler.capabilities,
    );
  }
}
