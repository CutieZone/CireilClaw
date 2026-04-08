import type { ConditionsConfig } from "$/config/schemas/conditions.js";
import { DiscordSession, TuiSession } from "$/harness/session.js";
import {
  agentRoot,
  checkConditionalAccess,
  root,
  sanitizeError,
  sandboxToReal,
  validateSystemPath,
} from "$/util/paths.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  realpathSync: vi.fn((path: string) => path),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("root", () => {
  it("returns ~/.cireilclaw", () => {
    vi.stubEnv("HOME", "/home/test");
    expect(root()).toBe("/home/test/.cireilclaw");
  });

  it("throws when HOME is unset", () => {
    vi.stubEnv("HOME", undefined);
    expect(() => root()).toThrow("$HOME variable not available");
  });
});

describe("agentRoot", () => {
  it("returns the agent directory under root", () => {
    vi.stubEnv("HOME", "/home/test");
    expect(agentRoot("myagent")).toBe("/home/test/.cireilclaw/agents/myagent");
  });
});

describe("sandboxToReal", () => {
  beforeEach(() => {
    vi.stubEnv("HOME", "/home/test");
  });

  it("maps /blocks/file.md to agent blocks dir", () => {
    expect(sandboxToReal("/blocks/file.md", "bot")).toBe(
      "/home/test/.cireilclaw/agents/bot/blocks/file.md",
    );
  });

  it("maps /memories to agent memories dir", () => {
    expect(sandboxToReal("/memories", "bot")).toBe("/home/test/.cireilclaw/agents/bot/memories");
  });

  it("maps /skills/nested/file.md correctly", () => {
    expect(sandboxToReal("/skills/nested/file.md", "bot")).toBe(
      "/home/test/.cireilclaw/agents/bot/skills/nested/file.md",
    );
  });

  it("maps /tasks/checklist.md correctly", () => {
    expect(sandboxToReal("/tasks/checklist.md", "bot")).toBe(
      "/home/test/.cireilclaw/agents/bot/tasks/checklist.md",
    );
  });

  it("maps /workspace correctly", () => {
    expect(sandboxToReal("/workspace", "bot")).toBe("/home/test/.cireilclaw/agents/bot/workspace");
  });

  it("rejects paths outside the 5 allowed prefixes", () => {
    expect(() => sandboxToReal("/etc/passwd", "bot")).toThrow("outside the sandbox");
  });

  it("rejects root path", () => {
    expect(() => sandboxToReal("/", "bot")).toThrow("outside the sandbox");
  });

  it("rejects path traversal via ../", () => {
    expect(() => sandboxToReal("/blocks/../../etc/passwd", "bot")).toThrow("attempts to escape");
  });

  it("rejects path traversal that crosses into a different sandbox area", () => {
    expect(() => sandboxToReal("/blocks/../memories/secret.md", "bot")).toThrow(
      "escaped the blocks sandbox area",
    );
  });

  it("allows deep nesting within the correct area", () => {
    expect(sandboxToReal("/workspace/a/b/c/d.txt", "bot")).toBe(
      "/home/test/.cireilclaw/agents/bot/workspace/a/b/c/d.txt",
    );
  });
});

describe("sanitizeError", () => {
  it("replaces agent root with <sandbox>", () => {
    vi.stubEnv("HOME", "/home/test");
    const err = new Error("/home/test/.cireilclaw/agents/bot/workspace/secret.txt not found");
    expect(sanitizeError(err, "bot")).toBe("<sandbox>/workspace/secret.txt not found");
  });

  it("handles non-Error values", () => {
    vi.stubEnv("HOME", "/home/test");
    expect(sanitizeError("string error", "bot")).toBe("string error");
  });
});

describe("validateSystemPath", () => {
  it("accepts /usr paths", () => {
    expect(validateSystemPath("/usr/bin/python")).toBe("/usr/bin/python");
  });

  it("accepts /lib paths", () => {
    expect(validateSystemPath("/lib/x86_64")).toBe("/lib/x86_64");
  });

  it("accepts /lib64", () => {
    expect(validateSystemPath("/lib64")).toBe("/lib64");
  });

  it("accepts /nix paths", () => {
    expect(validateSystemPath("/nix/store/abc")).toBe("/nix/store/abc");
  });

  it("rejects path traversal", () => {
    expect(() => validateSystemPath("/usr/../etc/passwd")).toThrow("path traversal");
  });

  it("rejects disallowed prefixes", () => {
    expect(() => validateSystemPath("/etc/passwd")).toThrow("outside the sandbox");
  });

  it("rejects /home paths", () => {
    expect(() => validateSystemPath("/home/user")).toThrow("outside the sandbox");
  });
});

describe("checkConditionalAccess", () => {
  function makeSession(opts: {
    channelId: string;
    guildId?: string;
    isNsfw?: boolean;
  }): DiscordSession {
    return new DiscordSession({
      channelId: opts.channelId,
      guildId: opts.guildId,
      isNsfw: opts.isNsfw ?? false,
    });
  }

  it("allows /blocks paths unconditionally (no rules)", () => {
    const session = makeSession({ channelId: "123" });
    const conditions: ConditionsConfig = { blocks: {}, memories: {}, workspace: {} };
    expect(() => {
      checkConditionalAccess("/blocks/file.md", "bot", conditions, session);
    }).not.toThrow();
  });

  it("allows /memories when no rules match the path", () => {
    const session = makeSession({ channelId: "123" });
    const conditions: ConditionsConfig = {
      blocks: {},
      memories: {
        "/nsfw/": { action: "deny", mode: "or", when: "discord:nsfw" },
      },
      workspace: {},
    };
    expect(() => {
      checkConditionalAccess("/memories/public/doc.md", "bot", conditions, session);
    }).not.toThrow();
  });

  it("denies /memories when deny rule matches", () => {
    const session = makeSession({ channelId: "123", isNsfw: true });
    const conditions: ConditionsConfig = {
      blocks: {},
      memories: {
        "/nsfw/": { action: "deny", mode: "or", when: "discord:nsfw" },
      },
      workspace: {},
    };
    expect(() => {
      checkConditionalAccess("/memories/nsfw/secret.md", "bot", conditions, session);
    }).toThrow("not accessible");
  });

  it("allows /workspace when allow rule matches", () => {
    const session = makeSession({ channelId: "123", guildId: "guild1" });
    const conditions: ConditionsConfig = {
      blocks: {},
      memories: {},
      workspace: {
        "/shared/": { action: "allow", mode: "or", when: "discord:guild:guild1" },
      },
    };
    expect(() => {
      checkConditionalAccess("/workspace/shared/file.md", "bot", conditions, session);
    }).not.toThrow();
  });

  it("denies /workspace when rules exist but none match conditions", () => {
    const session = makeSession({ channelId: "123", guildId: "otherguild" });
    const conditions: ConditionsConfig = {
      blocks: {},
      memories: {},
      workspace: {
        "/shared/": { action: "allow", mode: "or", when: "discord:guild:guild1" },
      },
    };
    expect(() => {
      checkConditionalAccess("/workspace/shared/file.md", "bot", conditions, session);
    }).toThrow("not accessible");
  });

  it("does not check conditions for non-memories/non-workspace paths", () => {
    const session = makeSession({ channelId: "123" });
    const conditions: ConditionsConfig = {
      blocks: {},
      memories: {
        "/secret/": { action: "deny", mode: "or", when: "tui" },
      },
      workspace: {},
    };
    expect(() => {
      checkConditionalAccess("/skills/something", "bot", conditions, session);
    }).not.toThrow();
  });

  it("works with TUI session for conditions", () => {
    const session = new TuiSession();
    const conditions: ConditionsConfig = {
      blocks: {},
      memories: {
        "/tui-only/": { action: "allow", mode: "or", when: "tui" },
      },
      workspace: {},
    };
    expect(() => {
      checkConditionalAccess("/memories/tui-only/doc.md", "bot", conditions, session);
    }).not.toThrow();
  });
});
