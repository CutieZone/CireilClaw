import type { TuiBridge } from "#channels/tui/bridge.js";
import { createTuiMessage } from "#channels/tui/tui-message.js";
import type { ChannelHandler } from "#harness/channel-handler.js";

export function createHandler(bridge: TuiBridge): ChannelHandler {
  return {
    capabilities: {
      supportsAttachments: false,
      supportsDownloadAttachments: false,
      supportsReactions: false,
    },
    // oxlint-disable-next-line typescript/require-await
    send: async (_session, content, _attachments) => {
      bridge.push(createTuiMessage("agent", content));
    },
  };
}
