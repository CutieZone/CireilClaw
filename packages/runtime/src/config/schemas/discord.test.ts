import * as vb from "valibot";
import { describe, expect, it } from "vitest";

import { DiscordConfigSchema, TrustedUserSchema } from "./discord.js";

const REQUIRED_CONFIG = {
  ownerId: "123456789",
  token: "bot-token",
};

describe("DiscordConfigSchema", () => {
  it("defaults Discord REST requests to a 60 second timeout", () => {
    expect(vb.parse(DiscordConfigSchema, REQUIRED_CONFIG).timeout).toBe(60_000);
  });

  it("keeps an explicitly configured Discord REST timeout", () => {
    expect(vb.parse(DiscordConfigSchema, { ...REQUIRED_CONFIG, timeout: 30_000 }).timeout).toBe(
      30_000,
    );
  });

  it("rejects a non-positive Discord REST timeout", () => {
    expect(() => vb.parse(DiscordConfigSchema, { ...REQUIRED_CONFIG, timeout: 0 })).toThrow();
  });

  it("defaults trustedUsers to an empty array", () => {
    expect(vb.parse(DiscordConfigSchema, REQUIRED_CONFIG).trustedUsers).toEqual([]);
  });

  it("parses trustedUsers entries", () => {
    const parsed = vb.parse(DiscordConfigSchema, {
      ...REQUIRED_CONFIG,
      trustedUsers: [
        {
          allowedCommands: ["stop", "summarize"],
          ids: ["987654321098765432"],
        },
      ],
    });
    expect(parsed.trustedUsers).toEqual([
      {
        allowedCommands: ["stop", "summarize"],
        ids: ["987654321098765432"],
      },
    ]);
  });

  it("rejects a trustedUsers entry with an invalid user ID", () => {
    expect(() =>
      vb.parse(DiscordConfigSchema, {
        ...REQUIRED_CONFIG,
        trustedUsers: [
          {
            allowedCommands: ["stop"],
            ids: ["not-a-snowflake"],
          },
        ],
      }),
    ).toThrow();
  });
});

describe("TrustedUserSchema", () => {
  it("parses a valid trusted user entry", () => {
    expect(
      vb.parse(TrustedUserSchema, {
        allowedCommands: ["clear"],
        ids: ["123456789012345678"],
      }),
    ).toEqual({
      allowedCommands: ["clear"],
      ids: ["123456789012345678"],
    });
  });
});
