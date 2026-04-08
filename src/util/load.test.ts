// oxlint-disable require-await
// oxlint-disable unicorn/no-useless-promise-resolve-reject
import { DiscordSession } from "$/harness/session.js";
import {
  blockLabels,
  loadBaseInstructions,
  loadBlocks,
  loadConditionalBlocks,
  loadSkills,
} from "$/util/load.js";
import { describe, expect, it, vi } from "vitest";

const mockFs = {
  existsSync: vi.fn(),
};

const mockFsPromises = {
  readFile: vi.fn(),
  readdir: vi.fn(),
};

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]): unknown => mockFs.existsSync(...args),
}));

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]): unknown => mockFsPromises.readFile(...args),
  readdir: (...args: unknown[]): unknown => mockFsPromises.readdir(...args),
}));

vi.stubEnv("HOME", "/home/test");

function tomlBlock(description: string, body: string): string {
  return `+++description="${description}"+++\n${body}`;
}

function yamlSkill(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

describe("loadBlocks", () => {
  it("loads all 5 required blocks with TOML frontmatter", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockImplementation(async (path: string) => {
      const label = blockLabels.find((lbl) => path.includes(`${lbl}.md`));
      return Promise.resolve(tomlBlock(label ?? "unknown", `${label}-content`));
    });

    const result = await loadBlocks("testagent");
    expect(Object.keys(result)).toEqual(["person", "identity", "long-term", "soul", "style-notes"]);
    expect(result["person"].content).toContain("person-content");
    expect(result["person"].description).toBe("person");
    expect(result["person"].filePath).toBe("/blocks/person.md");
  });

  it("throws when a required block is missing", async () => {
    mockFs.existsSync.mockReturnValue(false);
    await expect(loadBlocks("testagent")).rejects.toThrow("Missing required base file");
  });

  it("throws when frontmatter is missing opening +++", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("no frontmatter here");
    await expect(loadBlocks("testagent")).rejects.toThrow("invalid frontmatter");
  });

  it("throws when frontmatter is missing closing +++", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue('+++description="test"\nno closing');
    await expect(loadBlocks("testagent")).rejects.toThrow("invalid frontmatter");
  });
});

describe("loadBaseInstructions", () => {
  it("loads core.md", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("You are a helpful assistant.");
    const result = await loadBaseInstructions("testagent");
    expect(result).toBe("You are a helpful assistant.");
  });

  it("throws when core.md is missing", async () => {
    mockFs.existsSync.mockReturnValue(false);
    await expect(loadBaseInstructions("testagent")).rejects.toThrow("Missing required base file");
  });
});

describe("loadSkills", () => {
  it("returns empty array when skills dir does not exist", async () => {
    mockFs.existsSync.mockReturnValue(false);
    const result = await loadSkills("testagent");
    expect(result).toEqual([]);
  });

  it("loads skills with YAML frontmatter", async () => {
    const existsPaths = new Set<string>();
    mockFs.existsSync.mockImplementation((path: string) => existsPaths.has(path));

    mockFsPromises.readdir.mockResolvedValue([
      { isDirectory: (): boolean => true, name: "coding" },
      { isDirectory: (): boolean => true, name: "search" },
      { isDirectory: (): boolean => false, name: "notadir.md" },
    ]);

    existsPaths.add("/home/test/.cireilclaw/agents/testagent/skills");
    existsPaths.add("/home/test/.cireilclaw/agents/testagent/skills/coding/SKILL.md");
    existsPaths.add("/home/test/.cireilclaw/agents/testagent/skills/search/SKILL.md");

    mockFsPromises.readFile.mockImplementation(async (path: string) => {
      if (path.includes("coding")) {
        return Promise.resolve(yamlSkill("Coding", "Write code", "coding body"));
      }
      return Promise.resolve(yamlSkill("Search", "Search things", "search body"));
    });

    const result = await loadSkills("testagent");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ description: "Write code", slug: "coding" });
    expect(result[1]).toEqual({ description: "Search things", slug: "search" });
  });

  it("skips skill directories without SKILL.md", async () => {
    mockFs.existsSync.mockImplementation(
      (path: string) => path === "/home/test/.cireilclaw/agents/testagent/skills",
    );

    mockFsPromises.readdir.mockResolvedValue([{ isDirectory: (): boolean => true, name: "empty" }]);

    const result = await loadSkills("testagent");
    expect(result).toEqual([]);
  });

  it("throws when skill frontmatter is invalid", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readdir.mockResolvedValue([
      { isDirectory: (): boolean => true, name: "broken" },
    ]);
    mockFsPromises.readFile.mockResolvedValue("---\nbad: yaml\n---\ncontent");

    await expect(loadSkills("testagent")).rejects.toThrow();
  });
});

describe("loadConditionalBlocks", () => {
  it("returns empty when no blocks match", async () => {
    const session = new DiscordSession({ channelId: "1", guildId: "guild1" });
    const conditions = {
      blocks: {
        dm_only: { action: "load" as const, mode: "or" as const, when: "discord:dm" },
        nsfw_persona: { action: "load" as const, mode: "or" as const, when: "discord:nsfw" },
      },
      memories: {},
      workspace: {},
    };
    const result = await loadConditionalBlocks("testagent", conditions, session);
    expect(result).toEqual([]);
  });

  it("returns empty when conditional dir does not exist", async () => {
    const session = new DiscordSession({ channelId: "1", isNsfw: true });
    const conditions = {
      blocks: {
        nsfw_persona: { action: "load" as const, mode: "or" as const, when: "discord:nsfw" },
        tui_extra: { action: "load" as const, mode: "or" as const, when: "tui" },
      },
      memories: {},
      workspace: {},
    };

    mockFs.existsSync.mockReturnValue(false);
    const result = await loadConditionalBlocks("testagent", conditions, session);
    expect(result).toEqual([]);
  });

  it("loads matching conditional blocks", async () => {
    const session = new DiscordSession({ channelId: "1", isNsfw: true });
    const conditions = {
      blocks: {
        nsfw_persona: { action: "load" as const, mode: "or" as const, when: "discord:nsfw" },
        tui_extra: { action: "load" as const, mode: "or" as const, when: "tui" },
      },
      memories: {},
      workspace: {},
    };

    const existsPaths = new Set<string>();
    mockFs.existsSync.mockImplementation((path: string) => existsPaths.has(path));

    existsPaths.add("/home/test/.cireilclaw/agents/testagent/blocks/conditional");
    existsPaths.add("/home/test/.cireilclaw/agents/testagent/blocks/conditional/nsfw_persona.md");

    mockFsPromises.readFile.mockResolvedValue(
      tomlBlock("NSFW persona", "extra personality traits"),
    );

    const result = await loadConditionalBlocks("testagent", conditions, session);
    expect(result).toHaveLength(1);
    expect(result[0]?.label).toBe("conditional/nsfw_persona");
    expect(result[0]?.description).toBe("NSFW persona");
    expect(result[0]?.filePath).toBe("/blocks/conditional/nsfw_persona.md");
  });

  it("skips matching block names when file does not exist", async () => {
    const session = new DiscordSession({ channelId: "1", isNsfw: true });
    const conditions = {
      blocks: {
        nsfw_persona: { action: "load" as const, mode: "or" as const, when: "discord:nsfw" },
        tui_extra: { action: "load" as const, mode: "or" as const, when: "tui" },
      },
      memories: {},
      workspace: {},
    };

    mockFs.existsSync.mockImplementation(
      (path: string) => path === "/home/test/.cireilclaw/agents/testagent/blocks/conditional",
    );

    const result = await loadConditionalBlocks("testagent", conditions, session);
    expect(result).toEqual([]);
  });

  it("throws when conditional block has invalid frontmatter", async () => {
    const session = new DiscordSession({ channelId: "1", isNsfw: true });
    const conditions = {
      blocks: {
        nsfw_persona: { action: "load" as const, mode: "or" as const, when: "discord:nsfw" },
        tui_extra: { action: "load" as const, mode: "or" as const, when: "tui" },
      },
      memories: {},
      workspace: {},
    };

    const existsPaths = new Set<string>();
    mockFs.existsSync.mockImplementation((path: string) => existsPaths.has(path));

    existsPaths.add("/home/test/.cireilclaw/agents/testagent/blocks/conditional");
    existsPaths.add("/home/test/.cireilclaw/agents/testagent/blocks/conditional/nsfw_persona.md");

    mockFsPromises.readFile.mockResolvedValue("no frontmatter here");

    await expect(loadConditionalBlocks("testagent", conditions, session)).rejects.toThrow(
      "invalid frontmatter",
    );
  });
});
