import type { TuiBridge } from "$/channels/tui/bridge.js";
import type { ImageContent, VideoContent } from "$/engine/content.js";
import type { Message } from "$/engine/message.js";

const channelTypes = ["discord", "matrix", "internal", "tui"] as const;
type ChannelType = (typeof channelTypes)[number];

abstract class BaseSession {
  abstract readonly channel: ChannelType;
  readonly ephemeral: boolean = false;

  selectedModel?: string;
  selectedProvider?: string;

  history: Message[] = new Array<Message>();
  openedFiles: Set<string> = new Set<string>();
  pendingToolMessages: Message[] = new Array<Message>();
  // Images queued by tools (e.g. read) to be injected as a user message before the next generation.
  pendingImages: ImageContent[] = new Array<ImageContent>();
  // Videos queued from Discord attachments to be injected alongside pending images.
  pendingVideos: VideoContent[] = new Array<VideoContent>();

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
  lastMessageId?: string = undefined;

  constructor(
    channelId: string,
    selectedProvider?: string,
    selectedModel?: string,
    guildId?: string,
    isNsfw?: boolean,
  ) {
    super();
    this.channelId = channelId;
    this.selectedProvider = selectedProvider;
    this.selectedModel = selectedModel;

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
  override readonly ephemeral = true;

  readonly jobId: string;

  constructor(jobId: string) {
    super();
    this.jobId = jobId;
  }

  override id(): string {
    return `cron:${this.jobId}`;
  }
}

// Persistent session for heartbeats and named internal automation.
class NamedInternalSession extends BaseSession {
  override readonly channel = "internal";
  override readonly ephemeral = false;

  readonly name: string;

  constructor(name: string) {
    super();
    this.name = name;
  }

  override id(): string {
    return `internal:${this.name}`;
  }
}

class TuiSession extends BaseSession {
  override readonly channel = "tui";
  bridge?: TuiBridge;

  constructor(bridge?: TuiBridge) {
    super();
    this.bridge = bridge;
  }

  // oxlint-disable-next-line class-methods-use-this
  override id(): string {
    return "tui";
  }
}

type Session = DiscordSession | MatrixSession | InternalSession | NamedInternalSession | TuiSession;

export {
  DiscordSession,
  MatrixSession,
  InternalSession,
  NamedInternalSession,
  TuiSession,
  channelTypes as channelTypeList,
};
export type { Session, ChannelType };
