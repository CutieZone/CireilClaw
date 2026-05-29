import { afterEach, describe, expect, it, vi } from "vitest";

import { buildDiscordWarningContent, sendDiscordWarningMessage } from "./warning-message.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildDiscordWarningContent", () => {
  it("formats a visible warning with owner cleanup instructions", () => {
    expect(buildDiscordWarningContent("Discord error", "could not fetch channel")).toBe(
      "⚠️ Discord error: could not fetch channel\n\n-# agent owner can react with ✨ to delete",
    );
  });

  it("keeps warning content under Discord chunk limits", () => {
    const content = buildDiscordWarningContent("Discord error", "x".repeat(5000));

    expect(content.length).toBeLessThanOrEqual(1800);
    expect(content).toContain("…\n\n-# agent owner can react with ✨ to delete");
  });
});

describe("sendDiscordWarningMessage", () => {
  it("posts a referenced warning and adds the cleanup reaction", async () => {
    const createReaction = vi.fn(async () => {
      await Promise.resolve();
    });
    const createMessage = vi.fn(async () => await Promise.resolve({ createReaction }));
    const client = {
      rest: {
        channels: {
          createMessage,
        },
      },
    };
    const msg = {
      channelID: "channel-1",
      guildID: "guild-1",
      id: "message-1",
    };

    await sendDiscordWarningMessage(client, msg, "Discord error", "could not fetch channel");

    expect(createMessage).toHaveBeenCalledWith("channel-1", {
      allowedMentions: {
        repliedUser: true,
      },
      content:
        "⚠️ Discord error: could not fetch channel\n\n-# agent owner can react with ✨ to delete",
      messageReference: {
        channelID: "channel-1",
        guildID: "guild-1",
        messageID: "message-1",
      },
    });
    expect(createReaction).toHaveBeenCalledWith("✨");
  });

  it("does not throw when Discord rejects the warning message", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = {
      rest: {
        channels: {
          createMessage: async (): Promise<never> => {
            await Promise.resolve();
            throw new Error("Request Timed Out");
          },
        },
      },
    };
    const msg = {
      channelID: "channel-1",
      guildID: undefined,
      id: "message-1",
    };

    await expect(
      sendDiscordWarningMessage(client, msg, "Discord error", "could not fetch channel"),
    ).resolves.toBeUndefined();
  });
});
