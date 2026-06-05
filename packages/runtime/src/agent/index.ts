import type { Client as OceanicClient } from "oceanic.js";

import { loadConditions } from "#config/index.js";
import type { ConditionsConfig } from "#config/schemas/conditions.js";
import { runTurn } from "#engine/index.js";
import { MINIMAL_HANDLER } from "#harness/channel-handler.js";
import type {
  ChannelHandler,
  ChannelResolution,
  HistoryDirection,
  HistoryMessage,
} from "#harness/channel-handler.js";
import type { Session } from "#harness/session.js";
import { DiscordSession, NamedInternalSession, TuiSession } from "#harness/session.js";
import { Scheduler } from "#scheduler/index.js";

export class Agent {
  public readonly slug: string;
  public readonly sessions: Map<string, Session>;
  public readonly channelHandlers = new Map<string, ChannelHandler>();
  public conditions: ConditionsConfig;
  public discordClient?: OceanicClient;
  public ownerId?: string;
  public readonly scheduler?: Scheduler;

  public constructor(
    slug: string,
    sessions: Map<string, Session>,
    signal?: AbortSignal,
    conditions?: ConditionsConfig,
  ) {
    this.slug = slug;
    this.sessions = sessions;
    this.conditions = conditions ?? { blocks: {}, memories: {}, workspace: {} };

    if (signal !== undefined) {
      this.scheduler = new Scheduler(this, signal);
    }
  }

  public async updateConditions(): Promise<void> {
    this.conditions = await loadConditions(this.slug);
  }

  public registerChannel(channel: string, handler: ChannelHandler): void {
    this.channelHandlers.set(channel, handler);
  }

  public async resolveTarget(target: string): Promise<Session | undefined> {
    if (target === "none") {
      return undefined;
    }

    if (target === "last") {
      let best: Session | undefined = undefined;
      for (const session of this.sessions.values()) {
        if (best === undefined || session.lastActivity > best.lastActivity) {
          best = session;
        }
      }
      return best;
    }

    const existing = this.sessions.get(target);
    if (existing !== undefined) {
      return existing;
    }

    if (target.startsWith("internal:")) {
      const session = new NamedInternalSession(target.slice("internal:".length));
      this.sessions.set(target, session);
      return session;
    }

    if (target === "tui") {
      const session = new TuiSession();
      this.sessions.set(target, session);
      return session;
    }

    if (target.startsWith("discord:")) {
      const rest = target.slice("discord:".length);
      const [channelId, guildId] = rest.split("|");
      if (channelId !== undefined && channelId.length > 0) {
        const session = new DiscordSession({
          channelId,
          guildId: guildId ?? undefined,
        });
        this.sessions.set(target, session);
        return session;
      }
    }

    if (target === "owner") {
      if (this.ownerId === undefined || this.discordClient === undefined) {
        return undefined;
      }

      try {
        const dmChannel = await this.discordClient.rest.users.createDM(this.ownerId);
        const sessionId = `discord:${dmChannel.id}`;
        const prior = this.sessions.get(sessionId);
        if (prior !== undefined) {
          return prior;
        }

        const session = new DiscordSession({
          channelId: dmChannel.id,
        });
        this.sessions.set(sessionId, session);
        return session;
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  private getHandler(session: Session): ChannelHandler {
    return this.channelHandlers.get(session.channel) ?? MINIMAL_HANDLER;
  }

  public async send(
    session: Session,
    content: string,
    attachments?: string[],
    flags?: number,
  ): Promise<void> {
    if (session.sendFilter !== undefined && !session.sendFilter(content)) {
      return;
    }

    const handler = this.getHandler(session);
    await handler.send(session, content, attachments, flags);
  }

  // oxlint-disable-next-line require-await
  public async resolveChannel(spec: string, currentSession: Session): Promise<ChannelResolution> {
    if (spec === "current") {
      return currentSession;
    }

    if (spec === "last") {
      let best: Session | undefined = undefined;
      for (const session of this.sessions.values()) {
        if (best === undefined || session.lastActivity > best.lastActivity) {
          best = session;
        }
      }
      return best ?? { error: "no active sessions found" };
    }

    const handler = this.getHandler(currentSession);
    if (handler.resolveChannel !== undefined) {
      const result = handler.resolveChannel(spec, this.sessions, this.ownerId);
      return result;
    }

    return this.sessions.get(spec) ?? { error: `session not found: ${spec}` };
  }

  public async runTurn(session: Session): Promise<void> {
    const handler = this.getHandler(session);

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
      this.slug,
      {},
      send,
      sendTo,
      react,
      downloadAttachments,
      fetchHistory,
      resolveChannel,
      handler.capabilities,
      this.conditions,
    );
  }
}
