import * as vb from "valibot";
import { describe, expect, it } from "vitest";

import { DiscordConfigSchema } from "./discord.js";

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
});
