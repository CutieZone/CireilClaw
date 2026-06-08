import { beforeEach, describe, expect, it, vi } from "vitest";

import { edit } from "#engine/tools/edit.js";
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

describe("edit — exact matching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replaces exact text", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("The quick brown fox.");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    const result = await edit.execute(
      { new_text: "red", old_text: "brown", path: "/workspace/notes.txt" },
      ctx,
    );

    expect(result["success"]).toBe(true);
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      "The quick red fox.",
      "utf8",
    );
  });

  it("returns context around the replacement", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("Line 1\nLine 2\nLine 3\nLine 4\nLine 5");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    const result = await edit.execute(
      {
        new_text: "Changed line",
        old_text: "Line 3",
        path: "/workspace/notes.txt",
      },
      ctx,
    );

    expect(result["context"]).toContain("Changed line");
    expect(result["context"]).toContain("Line 2");
    expect(result["context"]).toContain("Line 4");
  });

  it("throws when file does not exist", async () => {
    mockFs.existsSync.mockReturnValue(false);

    const ctx = makeToolContext();
    await expect(
      edit.execute(
        {
          new_text: "nothing",
          old_text: "anything",
          path: "/blocks/person.md",
        },
        ctx,
      ),
    ).rejects.toThrow("does not exist");
  });
});

describe("edit — fuzzy whitespace matching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forgives extra indentation with all:true", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("  hello\n    world\n  foo");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    const result = await edit.execute(
      {
        all: true,
        new_text: "there",
        old_text: "world",
        path: "/workspace/notes.txt",
      },
      ctx,
    );

    expect(result["success"]).toBe(true);
    const { calls } = mockFsPromises.writeFile.mock;
    const [firstElement] = calls;
    const [, writtenContent] = (firstElement as unknown[] | undefined) ?? [];

    expect(writtenContent).toBe("  hello\nthere\n  foo");
  });

  it("forgives trailing spaces", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("hello   \nworld");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await edit.execute({ new_text: "hi", old_text: "hello", path: "/workspace/notes.txt" }, ctx);

    const { calls } = mockFsPromises.writeFile.mock;
    const [, writtenContent] = (calls[0] as unknown[] | undefined) ?? [];
    // Trailing spaces after "hello" are not consumed by the match,
    // so they remain in the output
    expect(writtenContent).toBe("hi   \nworld");
  });

  it("forgives tabs vs spaces", async () => {
    mockFs.existsSync.mockReturnValue(true);
    // File has spaces before 'bar', old_text has tab
    mockFsPromises.readFile.mockResolvedValue("foo\n    bar\nbaz");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await edit.execute(
      {
        all: true,
        new_text: "qux",
        old_text: "bar",
        path: "/workspace/notes.txt",
      },
      ctx,
    );

    const { calls } = mockFsPromises.writeFile.mock;
    const [firstElement] = calls;
    const [, writtenContent] = (firstElement as unknown[] | undefined) ?? [];
    expect(writtenContent).toBe("foo\nqux\nbaz");
  });

  it("forgives extra spaces between words", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("The quick   brown fox");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    const result = await edit.execute(
      {
        new_text: "fast",
        old_text: "quick brown",
        path: "/workspace/notes.txt",
      },
      ctx,
    );

    expect(result["success"]).toBe(true);
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      "The fast fox",
      "utf8",
    );
  });

  it("preserves blank lines structurally", async () => {
    mockFs.existsSync.mockReturnValue(true);
    // One blank line between foo and bar
    mockFsPromises.readFile.mockResolvedValue("foo\n\nbar");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await edit.execute(
      { new_text: "qux", old_text: "foo\n\nbar", path: "/workspace/notes.txt" },
      ctx,
    );

    const { calls } = mockFsPromises.writeFile.mock;
    const [firstElement] = calls;
    const [, writtenContent] = (firstElement as unknown[] | undefined) ?? [];
    // "foo\n\nbar" replaces everything, leaving only the replacement
    expect(writtenContent).toBe("qux");
  });

  it("deletes old_text when new_text is empty", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("hello world foo");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await edit.execute({ new_text: "", old_text: "world", path: "/workspace/notes.txt" }, ctx);

    const { calls } = mockFsPromises.writeFile.mock;
    const [firstElement] = calls;
    const [, writtenContent] = (firstElement as unknown[] | undefined) ?? [];
    expect(writtenContent).toBe("hello  foo");
  });
});

describe("edit — all flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replaces all occurrences when all: true", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("foo bar foo bar foo");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await edit.execute(
      {
        all: true,
        new_text: "qux",
        old_text: "foo",
        path: "/workspace/notes.txt",
      },
      ctx,
    );

    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      "qux bar qux bar qux",
      "utf8",
    );
  });

  it("reports replaced count", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("foo bar foo");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    const result = await edit.execute(
      {
        all: true,
        new_text: "qux",
        old_text: "foo",
        path: "/workspace/notes.txt",
      },
      ctx,
    );

    expect(result["replaced"]).toBe(2);
  });

  it("throws when all: false and multiple matches exist", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("foo bar foo baz foo");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await expect(
      edit.execute({ new_text: "qux", old_text: "foo", path: "/workspace/notes.txt" }, ctx),
    ).rejects.toThrow('Found 3 matches for "old_text"');
  });

  it("all: true works with fuzzy whitespace and different-original-text matches", async () => {
    mockFs.existsSync.mockReturnValue(true);
    // "  foo" and "\tfoo" both normalize to "foo"
    mockFsPromises.readFile.mockResolvedValue("  foo\nbar\n\tfoo\nbaz");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await edit.execute(
      {
        all: true,
        new_text: "qux",
        old_text: "foo",
        path: "/workspace/notes.txt",
      },
      ctx,
    );

    // Both "  foo" and "\tfoo" should be replaced (removed entirely since
    // the match span includes the whitespace consumed by normalization)
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      "qux\nbar\nqux\nbaz",
      "utf8",
    );
  });
});

describe("edit — near anchor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes search to within 15 lines of near match", async () => {
    mockFs.existsSync.mockReturnValue(true);
    // Two functions with same 'foo' variable — near disambiguates
    mockFsPromises.readFile.mockResolvedValue(
      "function alpha() {\n  const foo = 1;\n}\n\nfunction beta() {\n  const foo = 2;\n}\n",
    );

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await edit.execute(
      {
        all: true,
        near: "function beta",
        new_text: "const foo = 42;",
        old_text: "  const foo = 2;",
        path: "/workspace/notes.txt",
      },
      ctx,
    );

    const { calls } = mockFsPromises.writeFile.mock;
    const [firstElement] = calls;
    const [, writtenContent] = (firstElement as unknown[] | undefined) ?? [];
    expect(writtenContent).toBe(
      "function alpha() {\n  const foo = 1;\n}\n\nfunction beta() {\nconst foo = 42;\n}\n",
    );
  });

  it("throws when near not found", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("hello world");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await expect(
      edit.execute(
        {
          near: "nonexistent",
          new_text: "qux",
          old_text: "hello",
          path: "/workspace/notes.txt",
        },
        ctx,
      ),
    ).rejects.toThrow('Could not find "near"');
  });

  it("throws when near found but old_text not in any window", async () => {
    mockFs.existsSync.mockReturnValue(true);
    // "anchor" at line 1, but "target" is 30 lines below (beyond ±15 window)
    const lines: string[] = ["anchor"];
    for (let loopIdx = 1; loopIdx <= 40; loopIdx++) {
      lines.push(`line ${loopIdx}`);
    }
    lines.push("target");
    mockFsPromises.readFile.mockResolvedValue(lines.join("\n"));

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await expect(
      edit.execute(
        {
          near: "anchor",
          new_text: "replaced",
          old_text: "target",
          path: "/workspace/notes.txt",
        },
        ctx,
      ),
    ).rejects.toThrow("not found within 15 lines");
  });

  it("throws when all: false and multiple matches in different near windows", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue(
      "fn1\nx\ny\n// start\nconst foo = 1;\n// end\n\nfn2\n// start\nconst foo = 2;\n// end\n",
    );

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await expect(
      edit.execute(
        {
          near: "// start",
          new_text: "const foo = 42;",
          old_text: "const foo",
          path: "/workspace/notes.txt",
        },
        ctx,
      ),
    ).rejects.toThrow('Found 2 matches for "old_text"');
  });
});

describe("edit — frontmatter preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replaces text in body only, preserving block frontmatter", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue(
      '+++\ndescription="Personality"\n+++\nHello, my name is Bob.\nI like apples.',
    );

    const ctx = makeToolContext();
    const result = await edit.execute(
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
    const result = await edit.execute(
      {
        new_text: "New body",
        old_text: "Old body",
        path: "/skills/my-skill/SKILL.md",
      },
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
    await expect(
      edit.execute(
        {
          new_text: "New description",
          old_text: "Personality",
          path: "/blocks/person.md",
        },
        ctx,
      ),
    ).rejects.toThrow('Could not find "old_text"');
  });

  it("returns context with correct positions accounting for frontmatter offset", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue(
      '+++\ndescription="Personality"\n+++\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5',
    );

    const ctx = makeToolContext();
    const result = await edit.execute(
      {
        new_text: "Changed line",
        old_text: "Line 3",
        path: "/blocks/person.md",
      },
      ctx,
    );

    expect(result["success"]).toBe(true);
    expect(result["context"]).toContain("Changed line");
    expect(result["context"]).toContain("Line 2");
    expect(result["context"]).toContain("Line 4");
    // Frontmatter lines should not appear in context
    expect(result["context"]).not.toContain("+++");
  });

  it("throws when existing block frontmatter has invalid schema", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("+++\nother_field=42\n+++\nBody content here.");

    const ctx = makeToolContext();
    await expect(
      edit.execute(
        {
          new_text: "Updated body",
          old_text: "Body content",
          path: "/blocks/person.md",
        },
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
      edit.execute(
        {
          new_text: "New body",
          old_text: "Old body",
          path: "/skills/my-skill/SKILL.md",
        },
        ctx,
      ),
    ).rejects.toThrow("Invalid frontmatter");
  });
});

describe("edit — error messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows file excerpt when old_text not found", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("hello world");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await expect(
      edit.execute(
        {
          new_text: "qux",
          old_text: "nonexistent",
          path: "/workspace/notes.txt",
        },
        ctx,
      ),
    ).rejects.toThrow("File content (first 500 chars)");
  });

  it("shows file excerpt when near not found", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("some content here");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await expect(
      edit.execute(
        {
          near: "bogus",
          new_text: "qux",
          old_text: "content",
          path: "/workspace/notes.txt",
        },
        ctx,
      ),
    ).rejects.toThrow("File content (first 500 chars)");
  });
});

describe("edit — validation", () => {
  it("rejects empty old_text", async () => {
    const ctx = makeToolContext();
    await expect(
      edit.execute({ new_text: "qux", old_text: "", path: "/workspace/foo.txt" }, ctx),
    ).rejects.toThrow();
  });
});
