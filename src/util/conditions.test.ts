import type { BlockRule, Condition, PathRule } from "$/config/schemas/conditions.js";
import {
  DiscordSession,
  InternalSession,
  NamedInternalSession,
  TuiSession,
} from "$/harness/session.js";
import {
  checkPathAccess,
  evaluate,
  evaluateRule,
  getMatchingBlockNames,
} from "$/util/conditions.js";
import { describe, expect, it } from "vitest";

function makeDiscord(opts: {
  channelId?: string;
  guildId?: string;
  isNsfw?: boolean;
}): DiscordSession {
  return new DiscordSession({
    channelId: opts.channelId ?? "123",
    guildId: opts.guildId,
    isNsfw: opts.isNsfw ?? false,
  });
}

describe("evaluate", () => {
  it("tui matches TuiSession", () => {
    expect(evaluate("tui" as Condition, new TuiSession())).toBe(true);
  });

  it("tui does not match DiscordSession", () => {
    expect(evaluate("tui" as Condition, makeDiscord({}))).toBe(false);
  });

  it("internal matches InternalSession", () => {
    expect(evaluate("internal" as Condition, new InternalSession("job1"))).toBe(true);
  });

  it("internal matches NamedInternalSession", () => {
    expect(evaluate("internal" as Condition, new NamedInternalSession("heartbeat"))).toBe(true);
  });

  it("internal does not match DiscordSession", () => {
    expect(evaluate("internal" as Condition, makeDiscord({}))).toBe(false);
  });

  describe("discord:nsfw", () => {
    it("matches when nsfw is true", () => {
      expect(evaluate("discord:nsfw" as Condition, makeDiscord({ isNsfw: true }))).toBe(true);
    });

    it("does not match when nsfw is false", () => {
      expect(evaluate("discord:nsfw" as Condition, makeDiscord({ isNsfw: false }))).toBe(false);
    });

    it("does not match non-discord sessions", () => {
      expect(evaluate("discord:nsfw" as Condition, new TuiSession())).toBe(false);
    });
  });

  describe("discord:dm", () => {
    it("matches when no guildId", () => {
      expect(evaluate("discord:dm" as Condition, makeDiscord({ guildId: undefined }))).toBe(true);
    });

    it("does not match when in a guild", () => {
      expect(evaluate("discord:dm" as Condition, makeDiscord({ guildId: "guild1" }))).toBe(false);
    });

    it("does not match non-discord sessions", () => {
      expect(evaluate("discord:dm" as Condition, new TuiSession())).toBe(false);
    });
  });

  describe("discord:dm:<channelId>", () => {
    it("matches specific DM channel", () => {
      expect(evaluate("discord:dm:456" as Condition, makeDiscord({ channelId: "456" }))).toBe(true);
    });

    it("does not match different channel", () => {
      expect(evaluate("discord:dm:456" as Condition, makeDiscord({ channelId: "789" }))).toBe(
        false,
      );
    });

    it("does not match when in a guild", () => {
      expect(
        evaluate(
          "discord:dm:456" as Condition,
          makeDiscord({ channelId: "456", guildId: "guild1" }),
        ),
      ).toBe(false);
    });
  });

  describe("discord:guild:<guildId>", () => {
    it("matches when guild matches", () => {
      expect(
        evaluate("discord:guild:guild1" as Condition, makeDiscord({ guildId: "guild1" })),
      ).toBe(true);
    });

    it("does not match different guild", () => {
      expect(
        evaluate("discord:guild:guild1" as Condition, makeDiscord({ guildId: "guild2" })),
      ).toBe(false);
    });

    it("does not match DM", () => {
      expect(
        evaluate("discord:guild:guild1" as Condition, makeDiscord({ guildId: undefined })),
      ).toBe(false);
    });
  });

  describe("discord:channel:<channelId>", () => {
    it("matches when channel matches", () => {
      expect(evaluate("discord:channel:123" as Condition, makeDiscord({ channelId: "123" }))).toBe(
        true,
      );
    });

    it("does not match different channel", () => {
      expect(evaluate("discord:channel:123" as Condition, makeDiscord({ channelId: "456" }))).toBe(
        false,
      );
    });
  });

  it("returns false for unknown conditions", () => {
    expect(evaluate("unknown:thing" as Condition, makeDiscord({}))).toBe(false);
  });
});

describe("evaluateRule", () => {
  const session = makeDiscord({ guildId: "guild1", isNsfw: true });

  it("evaluates single condition in 'or' mode", () => {
    const rule = { mode: "or" as const, when: "discord:nsfw" as Condition };
    expect(evaluateRule(rule, session)).toBe(true);
  });

  it("evaluates multiple conditions in 'or' mode (any match)", () => {
    const rule: { when: Condition[]; mode: "or" } = {
      mode: "or",
      when: ["discord:nsfw", "tui"],
    };
    expect(evaluateRule(rule, session)).toBe(true);
  });

  it("returns false in 'or' mode when none match", () => {
    const rule: { when: Condition[]; mode: "or" } = {
      mode: "or",
      when: ["tui", "internal"],
    };
    expect(evaluateRule(rule, session)).toBe(false);
  });

  it("evaluates multiple conditions in 'and' mode (all must match)", () => {
    const rule: { when: Condition[]; mode: "and" } = {
      mode: "and",
      when: ["discord:nsfw", "discord:guild:guild1"],
    };
    expect(evaluateRule(rule, session)).toBe(true);
  });

  it("returns false in 'and' mode when one fails", () => {
    const rule: { when: Condition[]; mode: "and" } = {
      mode: "and",
      when: ["discord:nsfw", "discord:guild:guild2"],
    };
    expect(evaluateRule(rule, session)).toBe(false);
  });

  it("defaults to 'or' mode when mode is undefined", () => {
    const rule = { when: ["discord:nsfw", "tui"] as Condition[] };
    expect(evaluateRule(rule, session)).toBe(true);
  });
});

describe("getMatchingBlockNames", () => {
  it("returns empty array for undefined blocks", () => {
    expect(getMatchingBlockNames(undefined, makeDiscord({}))).toEqual([]);
  });

  it("returns empty array for empty blocks", () => {
    expect(getMatchingBlockNames({}, makeDiscord({}))).toEqual([]);
  });

  it("returns matching block names", () => {
    const blocks: Record<string, BlockRule> = {
      nsfw_stuff: { action: "load", mode: "or", when: "discord:nsfw" },
      tui_stuff: { action: "load", mode: "or", when: "tui" },
    };
    const session = makeDiscord({ isNsfw: true });
    expect(getMatchingBlockNames(blocks, session)).toEqual(["nsfw_stuff"]);
  });

  it("returns multiple matching blocks", () => {
    const blocks: Record<string, BlockRule> = {
      guild_block: { action: "load", mode: "or", when: "discord:guild:g1" },
      nsfw_block: { action: "load", mode: "or", when: "discord:nsfw" },
    };
    const session = makeDiscord({ guildId: "g1", isNsfw: true });
    const result = getMatchingBlockNames(blocks, session);
    expect(result).toContain("nsfw_block");
    expect(result).toContain("guild_block");
  });

  it("excludes non-matching blocks", () => {
    const blocks: Record<string, BlockRule> = {
      dm_only: { action: "load", mode: "or", when: "discord:dm" },
    };
    const session = makeDiscord({ guildId: "guild1" });
    expect(getMatchingBlockNames(blocks, session)).toEqual([]);
  });
});

describe("checkPathAccess", () => {
  it("returns true when rules are undefined", () => {
    expect(checkPathAccess("/memories/file.md", undefined, makeDiscord({}))).toBe(true);
  });

  it("returns true when no rules match the path", () => {
    const rules: Record<string, PathRule> = {
      "/secret/": { action: "deny", mode: "or", when: "discord:nsfw" },
    };
    expect(checkPathAccess("/public/file.md", rules, makeDiscord({}))).toBe(true);
  });

  it("denies when a deny rule matches conditions", () => {
    const rules: Record<string, PathRule> = {
      "/nsfw/": { action: "deny", mode: "or", when: "discord:nsfw" },
    };
    expect(checkPathAccess("/nsfw/secret.md", rules, makeDiscord({ isNsfw: true }))).toBe(false);
  });

  it("default-denies when a deny rule matches path but not conditions (no allow rule)", () => {
    const rules: Record<string, PathRule> = {
      "/nsfw/": { action: "deny", mode: "or", when: "discord:nsfw" },
    };
    expect(checkPathAccess("/nsfw/secret.md", rules, makeDiscord({ isNsfw: false }))).toBe(false);
  });

  it("allows when an allow rule matches conditions", () => {
    const rules: Record<string, PathRule> = {
      "/guild-data/": { action: "allow", mode: "or", when: "discord:guild:g1" },
    };
    expect(checkPathAccess("/guild-data/file.md", rules, makeDiscord({ guildId: "g1" }))).toBe(
      true,
    );
  });

  it("default-denies when rules exist but no conditions match", () => {
    const rules: Record<string, PathRule> = {
      "/guild-data/": { action: "allow", mode: "or", when: "discord:guild:g1" },
    };
    expect(checkPathAccess("/guild-data/file.md", rules, makeDiscord({ guildId: "g2" }))).toBe(
      false,
    );
  });

  it("deny takes precedence over allow", () => {
    expect(
      checkPathAccess(
        "/sensitive/file.md",
        {
          "/sensitive/": { action: "deny", mode: "or", when: "discord:nsfw" },
        },
        makeDiscord({ guildId: "g1", isNsfw: true }),
      ),
    ).toBe(false);
  });

  it("matches exact path (non-prefix rules)", () => {
    const rules: Record<string, PathRule> = {
      "/secret.md": { action: "deny", mode: "or", when: "discord:dm" },
    };
    expect(checkPathAccess("/secret.md", rules, makeDiscord({ guildId: undefined }))).toBe(false);
  });

  it("prefix rule matches the prefix without trailing slash", () => {
    const rules: Record<string, PathRule> = {
      "/nsfw/": { action: "deny", mode: "or", when: "discord:nsfw" },
    };
    expect(checkPathAccess("/nsfw", rules, makeDiscord({ isNsfw: true }))).toBe(false);
  });
});
