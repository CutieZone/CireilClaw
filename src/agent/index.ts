import type { ConditionsConfig } from "$/config/index.js";
import { loadConditions } from "$/config/index.js";
import type { EngineConfig } from "$/config/schemas.js";
import { Engine } from "$/engine/index.js";
import { MINIMAL_HANDLER } from "$/harness/channel-handler.js";
import type {
  ChannelHandler,
  ChannelResolution,
  HistoryDirection,
  HistoryMessage,
} from "$/harness/channel-handler.js";
import type { Session } from "$/harness/session.js";
import type { Client as OceanicClient } from "oceanic.js";

export class Agent {
  private _engine: Engine;
  private readonly _slug: string;
  private readonly _sessions: Map<string, Session>;
  private readonly _channelHandlers = new Map<string, ChannelHandler>();
  private _conditions: ConditionsConfig;
  private _discordClient?: OceanicClient;
  private _ownerId?: string;

  constructor(
    slug: string,
    cfg: EngineConfig,
    sessions: Map<string, Session>,
    conditions?: ConditionsConfig,
  ) {
    this._engine = new Engine(cfg);
    this._slug = slug;
    this._sessions = sessions;
    this._conditions = conditions ?? { blocks: {}, memories: {}, workspace: {} };
  }

  get engine(): Engine {
    return this._engine;
  }

  updateEngine(cfg: EngineConfig): void {
    this._engine = new Engine(cfg);
  }

  async updateConditions(): Promise<void> {
    this._conditions = await loadConditions(this._slug);
  }

  get conditions(): ConditionsConfig {
    return this._conditions;
  }

  get slug(): string {
    return this._slug;
  }

  get sessions(): Map<string, Session> {
    return this._sessions;
  }

  setDiscordClient(client: OceanicClient): void {
    this._discordClient = client;
  }

  get discordClient(): OceanicClient | undefined {
    return this._discordClient;
  }

  setOwnerId(ownerId: string): void {
    this._ownerId = ownerId;
  }

  get ownerId(): string | undefined {
    return this._ownerId;
  }

  registerChannel(channel: string, handler: ChannelHandler): void {
    this._channelHandlers.set(channel, handler);
  }

  private _getHandler(session: Session): ChannelHandler {
    return this._channelHandlers.get(session.channel) ?? MINIMAL_HANDLER;
  }

  async send(
    session: Session,
    content: string,
    attachments?: string[],
    flags?: number,
  ): Promise<void> {
    // Allow the session to intercept and optionally suppress delivery.
    if (session.sendFilter !== undefined && !session.sendFilter(content)) {
      return;
    }

    const handler = this._getHandler(session);
    await handler.send(session, content, attachments, flags);
  }

  // oxlint-disable-next-line require-await
  async resolveChannel(spec: string, currentSession: Session): Promise<ChannelResolution> {
    // "current" returns the current session
    if (spec === "current") {
      return currentSession;
    }

    // "last" returns the most recently active session
    if (spec === "last") {
      let best: Session | undefined = undefined;
      for (const session of this._sessions.values()) {
        if (best === undefined || session.lastActivity > best.lastActivity) {
          best = session;
        }
      }
      return best ?? { error: "no active sessions found" };
    }

    // Strip channel prefix (e.g., "discord:") before delegating to handler
    const handler = this._getHandler(currentSession);
    if (handler.resolveChannel !== undefined) {
      const prefix = `${currentSession.channel}:`;
      const bareSpec = spec.startsWith(prefix) ? spec.slice(prefix.length) : spec;
      const result = handler.resolveChannel(bareSpec, this._sessions, this._ownerId);
      return result;
    }

    // Fallback: direct session lookup
    return this._sessions.get(spec) ?? { error: `session not found: ${spec}` };
  }

  async runTurn(session: Session): Promise<void> {
    const handler = this._getHandler(session);

    const send = async (content: string, attachments?: string[]): Promise<void> => {
      await this.send(session, content, attachments);
    };

    const sendTo = async (
      targetSession: Session,
      content: string,
      attachments?: string[],
    ): Promise<void> => {
      await this.send(targetSession, content, attachments);
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

    const fetchHistory =
      handler.fetchHistory === undefined
        ? undefined
        : async (
            messageId: string,
            direction: HistoryDirection,
            limit?: number,
          ): Promise<HistoryMessage[]> => {
            const result = await handler.fetchHistory?.(session, messageId, direction, limit);
            return result ?? [];
          };

    // oxlint-disable-next-line require-await
    const resolveChannel = async (spec: string): Promise<ChannelResolution> =>
      this.resolveChannel(spec, session);

    await this._engine.runTurn(
      session,
      this._slug,
      send,
      sendTo,
      react,
      downloadAttachments,
      fetchHistory,
      resolveChannel,
      handler.capabilities,
      this._conditions,
    );
  }
}
