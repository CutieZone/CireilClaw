import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolContext } from "#engine/tools/tool-def.js";
import { write } from "#engine/tools/write.js";

const mockFs = {
  existsSync: vi.fn(),
};

const mockFsPromises = {
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
};

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]): unknown => mockFs.existsSync(...args),
  realpathSync: (path: string): string => path,
}));

vi.mock("node:fs/promises", () => ({
  mkdir: (...args: unknown[]): unknown => mockFsPromises.mkdir(...args),
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

describe("write tool schema", () => {
  it("rejects the /blocks directory as a file target", async () => {
    await expect(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      write.execute({ content: "", path: "/blocks" }, {} as ToolContext),
    ).rejects.toThrow("Files in /blocks/ must end with .md extension");
  });
});

describe("write tool frontmatter preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves existing frontmatter when new content lacks it (blocks)", async () => {
    const existingContent = '+++\ndescription="My personality"\n+++\nOriginal body content';
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue(existingContent);

    const ctx = makeToolContext();
    const result = await write.execute(
      { content: "New body content", path: "/blocks/person.md" },
      ctx,
    );

    expect(result["success"]).toBe(true);
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      '+++\ndescription="My personality"\n+++\nNew body content',
      "utf8",
    );
  });

  it("preserves existing frontmatter when new content lacks it (skills)", async () => {
    const existingContent = "---\nname: my-skill\ndescription: A skill\n---\nOriginal body";
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue(existingContent);

    const ctx = makeToolContext();
    const result = await write.execute(
      { content: "New body content", path: "/skills/my-skill/SKILL.md" },
      ctx,
    );

    expect(result["success"]).toBe(true);
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      "---\nname: my-skill\ndescription: A skill\n---\nNew body content",
      "utf8",
    );
  });

  it("does NOT prepend frontmatter when new content already includes it", async () => {
    const existingContent = '+++\ndescription="Old desc"\n+++\nOld body';
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue(existingContent);

    const ctx = makeToolContext();
    const result = await write.execute(
      {
        content: '+++\ndescription="New desc"\n+++\nNew body',
        path: "/blocks/person.md",
      },
      ctx,
    );

    expect(result["success"]).toBe(true);
    // Should use the new content as-is (agent explicitly provided frontmatter)
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      '+++\ndescription="New desc"\n+++\nNew body',
      "utf8",
    );
  });

  it("does NOT prepend frontmatter when file is new (doesn't exist yet)", async () => {
    mockFs.existsSync.mockReturnValue(false);

    const ctx = makeToolContext();
    const result = await write.execute(
      { content: "Fresh body content", path: "/blocks/person.md" },
      ctx,
    );

    expect(result["success"]).toBe(true);
    // New file, no existing frontmatter to preserve — write content as-is
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      "Fresh body content",
      "utf8",
    );
  });

  it("does NOT preserve frontmatter for non-block/skill paths", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("Some content");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/some/other/path.txt");
    const result = await write.execute(
      { content: "New content", path: "/workspace/notes.txt" },
      ctx,
    );

    expect(result["success"]).toBe(true);
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      "New content",
      "utf8",
    );
  });

  it("handles existing file without valid frontmatter gracefully", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("No frontmatter here");

    const ctx = makeToolContext();
    const result = await write.execute({ content: "New body", path: "/blocks/person.md" }, ctx);

    expect(result["success"]).toBe(true);
    // File exists but has no valid frontmatter — write new content as-is
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(expect.any(String), "New body", "utf8");
  });

  it("throws when existing block frontmatter has invalid schema", async () => {
    const existingContent = "+++\nother_field=42\n+++\nOriginal body";
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue(existingContent);

    const ctx = makeToolContext();
    await expect(
      write.execute({ content: "New body", path: "/blocks/person.md" }, ctx),
    ).rejects.toThrow("Invalid frontmatter");
    // writeFile should not be called — validation fails before writing
    expect(mockFsPromises.writeFile).not.toHaveBeenCalled();
  });

  it("throws when existing skill frontmatter has invalid schema (missing name)", async () => {
    const existingContent = "---\ndescription: A skill\n---\nOriginal body";
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue(existingContent);

    const ctx = makeToolContext();
    ctx.paths.resolve = vi
      .fn()
      .mockResolvedValue("/home/test/.cireilclaw/agents/testagent/skills/my-skill/SKILL.md");
    await expect(
      write.execute({ content: "New body", path: "/skills/my-skill/SKILL.md" }, ctx),
    ).rejects.toThrow("Invalid frontmatter");
    expect(mockFsPromises.writeFile).not.toHaveBeenCalled();
  });

  it("throws when agent provides invalid frontmatter for a new block file", async () => {
    mockFs.existsSync.mockReturnValue(false);

    const ctx = makeToolContext();
    ctx.paths.resolve = vi
      .fn()
      .mockResolvedValue("/home/test/.cireilclaw/agents/testagent/blocks/newblock.md");
    await expect(
      write.execute(
        {
          content: "+++\nnot-valid-toml-[[[\n+++\nNew body",
          path: "/blocks/newblock.md",
        },
        ctx,
      ),
    ).rejects.toThrow("Invalid frontmatter");
    expect(mockFsPromises.writeFile).not.toHaveBeenCalled();
  });

  it("allows new block file without frontmatter (no validation for agent content without delimiters)", async () => {
    mockFs.existsSync.mockReturnValue(false);

    const ctx = makeToolContext();
    ctx.paths.resolve = vi
      .fn()
      .mockResolvedValue("/home/test/.cireilclaw/agents/testagent/blocks/newblock.md");
    const result = await write.execute(
      { content: "Just body text, no frontmatter", path: "/blocks/newblock.md" },
      ctx,
    );

    expect(result["success"]).toBe(true);
    // The write is allowed through even though loading will fail — preserves existing behavior
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      "Just body text, no frontmatter",
      "utf8",
    );
  });
});
