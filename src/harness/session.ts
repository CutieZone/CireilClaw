import type { Message } from "$/engine/message.js";

type ChannelType = "discord" | "matrix";

interface BaseSession {
  channel: ChannelType;

  history: Message[];
  openedFiles: Set<string>;
  pendingToolMessages: Message[];

  id(): string;
}

interface DiscordSession extends BaseSession {
  channel: "discord";

  channelId: string;
  guildId?: string;
  isNsfw?: boolean;

  typingInterval?: NodeJS.Timeout;
}

interface MatrixSession extends BaseSession {
  channel: "matrix";
}

type Session = DiscordSession | MatrixSession;

export type { DiscordSession, Session };
