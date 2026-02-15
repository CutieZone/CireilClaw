import type { Message } from "$/engine/message.js";

type ChannelType = "discord" | "matrix";

abstract class BaseSession {
  abstract readonly channel: ChannelType;

  history: Message[] = new Array<Message>();
  openedFiles: Set<string> = new Set<string>();
  pendingToolMessages: Message[] = new Array<Message>();

  abstract id(): string;
}

class DiscordSession extends BaseSession {
  override readonly channel = "discord";

  readonly channelId: string;
  readonly guildId?: string;
  isNsfw?: boolean;

  typingInterval?: NodeJS.Timeout = undefined;

  constructor(channelId: string, guildId?: string, isNsfw?: boolean) {
    super();
    this.channelId = channelId;
    this.guildId = guildId;
    this.isNsfw = isNsfw;
  }

  override id(): string {
    if (this.guildId !== undefined) {
      return `discord:${this.channelId}|${this.guildId}`;
    }
    return `discord:${this.channelId}`;
  }
}

class MatrixSession extends BaseSession {
  override readonly channel = "matrix";

  readonly roomId: string;

  constructor(roomId: string) {
    super();
    this.roomId = roomId;
  }

  override id(): string {
    return `matrix:${this.roomId}`;
  }
}

type Session = DiscordSession | MatrixSession;

export { DiscordSession, MatrixSession };
export type { Session, ChannelType };
