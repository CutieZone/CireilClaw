import type { TuiBridge } from "#channels/tui/bridge.js";
import type { ImageContent, VideoContent } from "#engine/content.js";
import type { Message } from "#engine/message.js";

interface Summary {
  id: number;
  slug: string;
  displayName: string;
  startMessageId: string;
  endMessageId: string;
  preserve: string[];
  summary: string;
  createdAt: number;
}

const channelTypes = ["discord", "matrix", "internal", "tui"] as const;
type ChannelType = (typeof channelTypes)[number];

abstract class BaseSession {
  public abstract readonly channel: ChannelType;
  public readonly ephemeral: boolean = false;

  public selectedModel?: string;
  public selectedProvider?: string;

  public history: Message[] = new Array<Message>();
  // Index into history: messages from this index onward are sent to the LLM.
  // Pruning advances the cursor instead of mutating history, so tools like
  // read-session can still access the full conversation.
  public historyCursor = 0;
  public openedFiles: Set<string> = new Set<string>();
  // Active section filters for pinned files: path → set of section IDs.
  public activeFileSections = new Map<string, Set<string>>();
  // Topic compaction summaries for the session.
  public summaries: Summary[] = new Array<Summary>();
  public pendingToolMessages: Message[] = new Array<Message>();
  // Images queued by tools (e.g. read) to be injected as a user message before the next generation.
  public pendingImages: ImageContent[] = new Array<ImageContent>();
  // Videos queued from Discord attachments to be injected alongside pending images.
  public pendingVideos: VideoContent[] = new Array<VideoContent>();

  // Concurrency gate — true while a turn (user or scheduled) is in progress.
  public busy = false;
  // Set to true to request graceful termination of the current turn.
  // Checked after each generation completes; the assistant message is
  // committed to history (minus any unexecuted tool calls) and the loop exits.
  public stopRequested = false;
  // Timestamp (ms) of the last user-initiated message; used to resolve target = "last".
  public lastActivity = 0;
  // Timestamp (ms) of the most recent heartbeat turn for this session.
  public lastHeartbeatAt?: number;
  // Cursor value when the model was last asked to warn about imminent token pruning.
  public lastContextWarningCursor?: number;
  // Optional hook checked by Harness.send() — return false to suppress delivery.
  public sendFilter?: (content: string) => boolean = undefined;

  public abstract id(): string;

  /** Wipe conversation state while preserving session identity and user selections. */
  public reset(): void {
    this.history = [];
    this.historyCursor = 0;
    this.openedFiles = new Set();
    this.activeFileSections = new Map();
    this.summaries = [];
    this.pendingToolMessages = [];
    this.pendingImages = [];
    this.pendingVideos = [];
    this.lastContextWarningCursor = undefined;
    this.stopRequested = false;
  }
}

class DiscordSession extends BaseSession {
  public override readonly channel = "discord";

  public readonly channelId: string;
  public readonly guildId?: string;
  public isNsfw: boolean;

  public typingInterval?: NodeJS.Timeout = undefined;
  public lastMessageId?: string = undefined;

  public constructor(opts: {
    channelId: string;
    selectedProvider?: string;
    selectedModel?: string;
    guildId?: string;
    isNsfw?: boolean;
  }) {
    super();
    this.channelId = opts.channelId;
    this.selectedProvider = opts.selectedProvider;
    this.selectedModel = opts.selectedModel;

    this.guildId = opts.guildId;
    this.isNsfw = opts.isNsfw ?? false;
  }

  public override id(): string {
    if (this.guildId !== undefined) {
      return `discord:${this.channelId}|${this.guildId}`;
    }
    return `discord:${this.channelId}`;
  }
}

class MatrixSession extends BaseSession {
  public override readonly channel = "matrix";

  public readonly roomId: string;

  public constructor(roomId: string) {
    super();
    this.roomId = roomId;
  }

  public override id(): string {
    return `matrix:${this.roomId}`;
  }
}

// Ephemeral session for isolated cron job execution — never persisted to DB.
class InternalSession extends BaseSession {
  public override readonly channel = "internal";
  public override readonly ephemeral = true;

  public readonly jobId: string;

  public constructor(jobId: string) {
    super();
    this.jobId = jobId;
  }

  public override id(): string {
    return `cron:${this.jobId}`;
  }
}

// Persistent session for heartbeats and named internal automation.
class NamedInternalSession extends BaseSession {
  public override readonly channel = "internal";
  public override readonly ephemeral = false;

  public readonly name: string;

  public constructor(name: string) {
    super();
    this.name = name;
  }

  public override id(): string {
    return `internal:${this.name}`;
  }
}

class TuiSession extends BaseSession {
  public override readonly channel = "tui";
  public bridge?: TuiBridge;

  public constructor(bridge?: TuiBridge) {
    super();
    this.bridge = bridge;
  }

  // oxlint-disable-next-line class-methods-use-this
  public override id(): string {
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
export type { Session, ChannelType, Summary };
