import { beforeEach, describe, expect, it, vi } from "vitest";

import { strReplace } from "#engine/tools/str-replace.js";
import type { ToolContext } from "#engine/tools/tool-def.js";

const mockFs = {
  existsSync: vi.fn(),
};

const mockFsPromises = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
};

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]): unknown => mockFs.existsSync(...args),
  realpathSync: (path: string): string => path,
}));

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]): unknown => mockFsPromises.readFile(...args),
  writeFile: (...args: unknown[]): unknown => mockFsPromises.writeFile(...args),
}));

vi.stubEnv("HOME", "/home/test");

function makeToolContext(): ToolContext {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    paths: {
      checkAccess: vi.fn().mockResolvedValue(undefined),
      checkConditionalAccess: vi.fn().mockResolvedValue(undefined),
      checkWriteAccess: vi.fn().mockResolvedValue(undefined),
      resolve: vi
        .fn()
        .mockResolvedValue("/home/test/.cireilclaw/agents/testagent/blocks/person.md"),
    },
    session: {
      activeFileSections: new Map(),
    },
  } as unknown as ToolContext;
}

describe("str-replace frontmatter preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replaces text in body only, preserving block frontmatter", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue(
      '+++\ndescription="Personality"\n+++\nHello, my name is Bob.\nI like apples.',
    );

    const ctx = makeToolContext();
    const result = await strReplace.execute(
      { new_text: "Alice", old_text: "Bob", path: "/blocks/person.md" },
      ctx,
    );

    expect(result["success"]).toBe(true);
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      '+++\ndescription="Personality"\n+++\nHello, my name is Alice.\nI like apples.',
      "utf8",
    );
  });

  it("replaces text in body only, preserving skill frontmatter", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue(
      "---\nname: my-skill\ndescription: A skill\n---\nOld body text here",
    );

    const ctx = makeToolContext();
    const result = await strReplace.execute(
      { new_text: "New body", old_text: "Old body", path: "/skills/my-skill/SKILL.md" },
      ctx,
    );

    expect(result["success"]).toBe(true);
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      "---\nname: my-skill\ndescription: A skill\n---\nNew body text here",
      "utf8",
    );
  });

  it("does NOT match text inside frontmatter (only searches body)", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue(
      '+++\ndescription="Personality"\n+++\nBody content here.',
    );

    const ctx = makeToolContext();
    // "Personality" appears in the frontmatter but not the body
    await expect(
      strReplace.execute(
        { new_text: "New description", old_text: "Personality", path: "/blocks/person.md" },
        ctx,
      ),
    ).rejects.toThrow("does not contain old_text");
  });

  it("searches full content for non-block/skill paths (no frontmatter isolation)", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("The quick brown fox");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    const result = await strReplace.execute(
      { new_text: "red", old_text: "brown", path: "/workspace/notes.txt" },
      ctx,
    );

    expect(result["success"]).toBe(true);
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      "The quick red fox",
      "utf8",
    );
  });

  it("returns context lines with correct positions accounting for frontmatter offset", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue(
      '+++\ndescription="Personality"\n+++\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5',
    );

    const ctx = makeToolContext();
    const result = await strReplace.execute(
      { new_text: "Changed line", old_text: "Line 3", path: "/blocks/person.md" },
      ctx,
    );

    expect(result["success"]).toBe(true);
    expect(result["context"]).toContain("Changed line");
    // Should show surrounding context from full file
    expect(result["context"]).toContain("Line 2");
    expect(result["context"]).toContain("Line 4");
    // Frontmatter lines should not appear in context (they're before the replacement)
    expect(result["context"]).not.toContain("+++");
  });

  it("throws when file does not exist", async () => {
    mockFs.existsSync.mockReturnValue(false);

    const ctx = makeToolContext();
    await expect(
      strReplace.execute(
        { new_text: "nothing", old_text: "anything", path: "/blocks/person.md" },
        ctx,
      ),
    ).rejects.toThrow("does not exist");
  });

  it("throws when existing block frontmatter has invalid schema", async () => {
    mockFs.existsSync.mockReturnValue(true);
    // TOML syntax is valid but `description` field is missing
    mockFsPromises.readFile.mockResolvedValue("+++\nother_field=42\n+++\nBody content here.");

    const ctx = makeToolContext();
    await expect(
      strReplace.execute(
        { new_text: "Updated body", old_text: "Body content", path: "/blocks/person.md" },
        ctx,
      ),
    ).rejects.toThrow("Invalid frontmatter");
  });

  it("throws when existing skill frontmatter has invalid schema (missing name)", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("---\ndescription: A skill\n---\nOld body text here");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi
      .fn()
      .mockResolvedValue("/home/test/.cireilclaw/agents/testagent/skills/my-skill/SKILL.md");
    await expect(
      strReplace.execute(
        { new_text: "New body", old_text: "Old body", path: "/skills/my-skill/SKILL.md" },
        ctx,
      ),
    ).rejects.toThrow("Invalid frontmatter");
  });
});
