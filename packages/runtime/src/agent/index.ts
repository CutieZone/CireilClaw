import { loadConditions } from "$/config/index.js";
import type { ConditionsConfig } from "$/config/schemas/conditions.js";
import { runTurn } from "$/engine/index.js";
import { MINIMAL_HANDLER } from "$/harness/channel-handler.js";
import type {
  ChannelHandler,
  ChannelResolution,
  HistoryDirection,
  HistoryMessage,
} from "$/harness/channel-handler.js";
import type { Session } from "$/harness/session.js";
import { DiscordSession, NamedInternalSession, TuiSession } from "$/harness/session.js";
import { Scheduler } from "$/scheduler/index.js";
import type { Client as OceanicClient } from "oceanic.js";

export class Agent {
  private readonly _slug: string;
  private readonly _sessions: Map<string, Session>;
  private readonly _channelHandlers = new Map<string, ChannelHandler>();
  private _conditions: ConditionsConfig;
  private _discordClient?: OceanicClient;
  private _ownerId?: string;
  private readonly _scheduler?: Scheduler;

  constructor(
    slug: string,
    sessions: Map<string, Session>,
    signal?: AbortSignal,
    conditions?: ConditionsConfig,
  ) {
    this._slug = slug;
    this._sessions = sessions;
    this._conditions = conditions ?? { blocks: {}, memories: {}, workspace: {} };

    if (signal !== undefined) {
      this._scheduler = new Scheduler(this, signal);
    }
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

  get scheduler(): Scheduler | undefined {
    return this._scheduler;
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

  // Resolve a scheduler target string to a session, auto-creating ephemeral
  // sessions (internal, TUI, Discord) when the target is valid but missing.
  resolveTarget(target: string): Session | undefined {
    if (target === "none") {
      return undefined;
    }

    if (target === "last") {
      let best: Session | undefined = undefined;
      for (const session of this._sessions.values()) {
        if (best === undefined || session.lastActivity > best.lastActivity) {
          best = session;
        }
      }
      return best;
    }

    const existing = this._sessions.get(target);
    if (existing !== undefined) {
      return existing;
    }

    // Auto-create named internal or TUI sessions if requested but missing.
    if (target.startsWith("internal:")) {
      const session = new NamedInternalSession(target.slice("internal:".length));
      this._sessions.set(target, session);
      return session;
    }

    if (target === "tui") {
      const session = new TuiSession();
      this._sessions.set(target, session);
      return session;
    }

    // Auto-create Discord sessions for valid targets.
    if (target.startsWith("discord:")) {
      const rest = target.slice("discord:".length);
      const [channelId, guildId] = rest.split("|");
      if (channelId !== undefined && channelId.length > 0) {
        const session = new DiscordSession({
          channelId,
          guildId: guildId ?? undefined,
        });
        this._sessions.set(target, session);
        return session;
      }
    }

    return undefined;
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

    const handler = this._getHandler(currentSession);
    if (handler.resolveChannel !== undefined) {
      const result = handler.resolveChannel(spec, this._sessions, this._ownerId);
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

    await runTurn(
      session,
      this._slug,
      {},
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
