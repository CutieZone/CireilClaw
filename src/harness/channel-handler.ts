import type { Session } from "$/harness/session.js";

interface ChannelCapabilities {
  supportsAttachments: boolean;
  supportsDownloadAttachments: boolean;
  supportsReactions: boolean;
}

// Channel resolution result for cross-channel messaging
type ChannelResolution = Session | { error: string };

interface HistoryMessage {
  authorId: string;
  authorName: string;
  content: string;
  formatted: string;
  id: string;
  timestamp: string;
}

type HistoryDirection = "after" | "around" | "before";

interface ChannelHandler {
  readonly capabilities: ChannelCapabilities;
  downloadAttachments?(
    session: Session,
    messageId: string,
  ): Promise<{ filename: string; data: Buffer }[]>;
  fetchHistory?(
    session: Session,
    messageId: string,
    direction: HistoryDirection,
    limit?: number,
  ): Promise<HistoryMessage[]>;
  react?(session: Session, emoji: string, messageId?: string): Promise<void>;
  send(session: Session, content: string, attachments?: string[], flags?: number): Promise<void>;
  resolveChannel?(
    spec: string,
    sessions: Map<string, Session>,
    ownerId?: string,
  ): Promise<ChannelResolution>;
}

const MINIMAL_HANDLER: ChannelHandler = {
  capabilities: {
    supportsAttachments: false,
    supportsDownloadAttachments: false,
    supportsReactions: false,
  },
  send: () => {
    throw new Error("This channel does not support sending messages");
  },
};

export {
  type ChannelCapabilities,
  type ChannelHandler,
  type ChannelResolution,
  type HistoryDirection,
  type HistoryMessage,
  MINIMAL_HANDLER,
};
