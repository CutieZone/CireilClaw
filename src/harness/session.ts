import type { ImageContent } from "$/engine/content.js";
import type { Message } from "$/engine/message.js";

const channelTypes = ["discord", "matrix", "internal"] as const;
type ChannelType = (typeof channelTypes)[number];

abstract class BaseSession {
  abstract readonly channel: ChannelType;

  history: Message[] = new Array<Message>();
  openedFiles: Set<string> = new Set<string>();
  pendingToolMessages: Message[] = new Array<Message>();
  // Images queued by tools (e.g. read) to be injected as a user message before the next generation.
  pendingImages: ImageContent[] = new Array<ImageContent>();

  // Concurrency gate — true while a turn (user or scheduled) is in progress.
  busy = false;
  // Timestamp (ms) of the last user-initiated message; used to resolve target = "last".
  lastActivity = 0;
  // Optional hook checked by Harness.send() — return false to suppress delivery.
  sendFilter?: (content: string) => boolean = undefined;

  abstract id(): string;
}

class DiscordSession extends BaseSession {
  override readonly channel = "discord";

  readonly channelId: string;
  readonly guildId?: string;
  isNsfw: boolean;

  typingInterval?: NodeJS.Timeout = undefined;

  constructor(channelId: string, guildId?: string, isNsfw?: boolean) {
    super();
    this.channelId = channelId;
    this.guildId = guildId;
    this.isNsfw = isNsfw ?? false;
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

// Ephemeral session for isolated cron job execution — never persisted to DB.
class InternalSession extends BaseSession {
  override readonly channel = "internal";

  readonly jobId: string;

  constructor(jobId: string) {
    super();
    this.jobId = jobId;
  }

  override id(): string {
    return `cron:${this.jobId}`;
  }
}

type Session = DiscordSession | MatrixSession | InternalSession;

export { DiscordSession, MatrixSession, InternalSession, channelTypes as channelTypeList };
export type { Session, ChannelType };
