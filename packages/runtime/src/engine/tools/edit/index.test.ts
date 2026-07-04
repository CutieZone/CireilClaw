import { beforeEach, describe, expect, it, vi } from "vitest";

import { edit } from "#engine/tools/edit/index.js";
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
      { old_text: "brown", new_text: "red", path: "/workspace/notes.txt" },
      ctx,
    );

    expect(result["success"]).toBe(true);
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      "The quick red fox.",
      "utf8",
    );
  });

  it("returns detail about the replacement", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("Line 1\nLine 2\nLine 3\nLine 4\nLine 5");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    const result = await edit.execute(
      {
        old_text: "Line 3",
        new_text: "Changed line",
        path: "/workspace/notes.txt",
      },
      ctx,
    );

    expect(result["detail"]).toContain("Successfully replaced");
    expect(result["detail"]).toContain("1 block(s)");
    expect(result["diff"]).toContain("Changed line");
    expect(result["diff"]).toContain("Line 2");
    expect(result["diff"]).toContain("Line 4");
    expect(result["edits"]).toHaveLength(1);
  });

  it("throws when file does not exist", async () => {
    mockFs.existsSync.mockReturnValue(false);

    const ctx = makeToolContext();
    await expect(
      edit.execute(
        {
          old_text: "anything",
          new_text: "nothing",
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
    await edit.execute(
      {
        all: true,
        old_text: "world",
        new_text: "there",
        path: "/workspace/notes.txt",
      },
      ctx,
    );

    const { calls } = mockFsPromises.writeFile.mock;
    const [firstElement] = calls;
    const [, writtenContent] = (firstElement as unknown[] | undefined) ?? [];

    // Leading whitespace is preserved — only the matched text is replaced
    expect(writtenContent).toBe("  hello\n    there\n  foo");
  });

  it("forgives trailing spaces", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("hello   \nworld");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await edit.execute({ old_text: "hello", new_text: "hi", path: "/workspace/notes.txt" }, ctx);

    const { calls } = mockFsPromises.writeFile.mock;
    const [, writtenContent] = (calls[0] as unknown[] | undefined) ?? [];
    expect(writtenContent).toBe("hi   \nworld");
  });

  it("forgives tabs vs spaces", async () => {
    mockFs.existsSync.mockReturnValue(true);
    // File has spaces before 'bar', old_text has no leading whitespace
    mockFsPromises.readFile.mockResolvedValue("foo\n    bar\nbaz");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await edit.execute(
      {
        all: true,
        old_text: "bar",
        new_text: "qux",
        path: "/workspace/notes.txt",
      },
      ctx,
    );

    const { calls } = mockFsPromises.writeFile.mock;
    const [firstElement] = calls;
    const [, writtenContent] = (firstElement as unknown[] | undefined) ?? [];
    // Leading whitespace is preserved — only the matched text is replaced
    expect(writtenContent).toBe("foo\n    qux\nbaz");
  });

  it("forgives extra spaces between words", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("The quick   brown fox");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    const result = await edit.execute(
      {
        old_text: "quick brown",
        new_text: "fast",
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
      { old_text: "foo\n\nbar", new_text: "qux", path: "/workspace/notes.txt" },
      ctx,
    );

    const { calls } = mockFsPromises.writeFile.mock;
    const [firstElement] = calls;
    const [, writtenContent] = (firstElement as unknown[] | undefined) ?? [];
    expect(writtenContent).toBe("qux");
  });

  it("deletes old_text when new_text is empty", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("hello world foo");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await edit.execute({ old_text: "world", new_text: "", path: "/workspace/notes.txt" }, ctx);

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
        old_text: "foo",
        new_text: "qux",
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

  it("reports replaced count via edits array length", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("foo bar foo");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    const result = await edit.execute(
      {
        all: true,
        old_text: "foo",
        new_text: "qux",
        path: "/workspace/notes.txt",
      },
      ctx,
    );

    expect(result["edits"]).toHaveLength(2);
  });

  it("throws when all: false and multiple matches exist", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("foo bar foo baz foo");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await expect(
      edit.execute({ old_text: "foo", new_text: "qux", path: "/workspace/notes.txt" }, ctx),
    ).rejects.toThrow("Found 3 matches for edits[0]");
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
        old_text: "foo",
        new_text: "qux",
        path: "/workspace/notes.txt",
      },
      ctx,
    );

    // Leading whitespace is preserved — only the matched text is replaced
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      "  qux\nbar\n\tqux\nbaz",
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
    mockFsPromises.readFile.mockResolvedValue(
      "function alpha() {\n  const foo = 1;\n}\n\nfunction beta() {\n  const foo = 2;\n}\n",
    );

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await edit.execute(
      {
        all: true,
        near: "function beta",
        old_text: "  const foo = 2;",
        new_text: "const foo = 42;",
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
          old_text: "hello",
          new_text: "qux",
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
          old_text: "target",
          new_text: "replaced",
          path: "/workspace/notes.txt",
        },
        ctx,
      ),
    ).rejects.toThrow("not found within");
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
          old_text: "const foo",
          new_text: "const foo = 42;",
          path: "/workspace/notes.txt",
        },
        ctx,
      ),
    ).rejects.toThrow("Found 2 matches for edits[0]");
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
      { old_text: "Bob", new_text: "Alice", path: "/blocks/person.md" },
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
        old_text: "Old body",
        new_text: "New body",
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
          old_text: "Personality",
          new_text: "New description",
          path: "/blocks/person.md",
        },
        ctx,
      ),
    ).rejects.toThrow("Could not find edits[0]");
  });

  it("returns diff with correct positions accounting for frontmatter offset", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue(
      '+++\ndescription="Personality"\n+++\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5',
    );

    const ctx = makeToolContext();
    const result = await edit.execute(
      {
        old_text: "Line 3",
        new_text: "Changed line",
        path: "/blocks/person.md",
      },
      ctx,
    );

    expect(result["success"]).toBe(true);
    // Diff should reference the changed content
    expect(result["diff"]).toContain("Changed line");
    expect(result["diff"]).toContain("Line 2");
    expect(result["diff"]).toContain("Line 4");
    // Frontmatter lines should not appear in diff
    expect(result["diff"]).not.toContain("+++");
  });

  it("throws when existing block frontmatter has invalid schema", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("+++\nother_field=42\n+++\nBody content here.");

    const ctx = makeToolContext();
    await expect(
      edit.execute(
        {
          old_text: "Body content",
          new_text: "Updated body",
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
          old_text: "Old body",
          new_text: "New body",
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

  it("shows error when old_text not found", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("hello world");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await expect(
      edit.execute(
        {
          old_text: "nonexistent",
          new_text: "qux",
          path: "/workspace/notes.txt",
        },
        ctx,
      ),
    ).rejects.toThrow("Could not find edits[0]");
  });

  it("shows error when near not found", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockResolvedValue("some content here");

    const ctx = makeToolContext();
    ctx.paths.resolve = vi.fn().mockResolvedValue("/workspace/notes.txt");
    await expect(
      edit.execute(
        {
          near: "bogus",
          old_text: "content",
          new_text: "qux",
          path: "/workspace/notes.txt",
        },
        ctx,
      ),
    ).rejects.toThrow('Could not find "near"');
  });
});

describe("edit — validation", () => {
  it("rejects empty old_text", async () => {
    const ctx = makeToolContext();
    await expect(
      edit.execute({ old_text: "", new_text: "qux", path: "/workspace/foo.txt" }, ctx),
    ).rejects.toThrow();
  });
});
