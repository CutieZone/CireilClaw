import type { Session } from "$/harness/session.js";

interface ChannelCapabilities {
  supportsAttachments: boolean;
  supportsDownloadAttachments: boolean;
  supportsReactions: boolean;
}

interface ChannelHandler {
  readonly capabilities: ChannelCapabilities;
  downloadAttachments?(
    session: Session,
    messageId: string,
  ): Promise<{ filename: string; data: Buffer }[]>;
  react?(session: Session, emoji: string, messageId?: string): Promise<void>;
  send(session: Session, content: string, attachments?: string[], flags?: number): Promise<void>;
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

export { type ChannelCapabilities, type ChannelHandler, MINIMAL_HANDLER };
