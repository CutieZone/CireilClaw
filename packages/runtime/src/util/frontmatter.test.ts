import { describe, expect, it } from "vitest";

import { requiresFrontmatter, splitFrontmatter, validateFrontmatter } from "#util/frontmatter.js";

describe("requiresFrontmatter", () => {
  it("returns true for /blocks/ paths", () => {
    expect(requiresFrontmatter("/blocks/person.md")).toBe(true);
    expect(requiresFrontmatter("/blocks/identity.md")).toBe(true);
    expect(requiresFrontmatter("/blocks/conditional/nsfw.md")).toBe(true);
    expect(requiresFrontmatter("/blocks/foo/bar/baz.md")).toBe(true);
  });

  it("returns true for /skills/**/SKILL.md paths", () => {
    expect(requiresFrontmatter("/skills/my-skill/SKILL.md")).toBe(true);
    expect(requiresFrontmatter("/skills/coding/SKILL.md")).toBe(true);
  });

  it("returns false for non-SKILL.md files under /skills/", () => {
    expect(requiresFrontmatter("/skills/coding/README.md")).toBe(false);
    expect(requiresFrontmatter("/skills/my-skill/notes.txt")).toBe(false);
  });

  it("returns false for other paths", () => {
    expect(requiresFrontmatter("/workspace/main.ts")).toBe(false);
    expect(requiresFrontmatter("/memories/note.md")).toBe(false);
    expect(requiresFrontmatter("/tasks/HEARTBEAT.md")).toBe(false);
    expect(requiresFrontmatter("/some/other/path.txt")).toBe(false);
  });
});

function expectFrontmatter(input: string, isBlock: boolean): { body: string; frontmatter: string } {
  const result = splitFrontmatter(input, isBlock);
  if (result === undefined) {
    throw new Error("Expected frontmatter to be defined");
  }
  return result;
}

describe("splitFrontmatter", () => {
  describe("blocks (TOML, +++ delimiter)", () => {
    it("extracts TOML frontmatter and body", () => {
      const { body, frontmatter } = expectFrontmatter(
        '+++\ndescription="Personality"\n+++\nThis is the body.',
        true,
      );
      expect(frontmatter).toBe('+++\ndescription="Personality"\n+++\n');
      expect(body).toBe("This is the body.");
    });

    it("handles multi-line frontmatter", () => {
      const { body, frontmatter } = expectFrontmatter(
        '+++\ndescription="My block"\nextra=42\n+++\nbody line 1\nbody line 2',
        true,
      );
      expect(frontmatter).toBe('+++\ndescription="My block"\nextra=42\n+++\n');
      expect(body).toBe("body line 1\nbody line 2");
    });

    it("handles body without trailing newline", () => {
      const { body, frontmatter } = expectFrontmatter(
        '+++\ndescription="test"\n+++\njust a body',
        true,
      );
      expect(frontmatter).toBe('+++\ndescription="test"\n+++\n');
      expect(body).toBe("just a body");
    });

    it("returns undefined when file doesn't start with +++", () => {
      expect(splitFrontmatter("no frontmatter here", true)).toBeUndefined();
    });

    it("returns undefined when frontmatter has no closing +++", () => {
      expect(splitFrontmatter('+++\ndescription="no close', true)).toBeUndefined();
    });
  });

  describe("skills (YAML, --- delimiter)", () => {
    it("extracts YAML frontmatter and body", () => {
      const { body, frontmatter } = expectFrontmatter(
        "---\nname: my-skill\ndescription: A skill\n---\nbody content here",
        false,
      );
      expect(frontmatter).toBe("---\nname: my-skill\ndescription: A skill\n---\n");
      expect(body).toBe("body content here");
    });

    it("returns undefined when file doesn't start with ---", () => {
      expect(splitFrontmatter("no frontmatter here", false)).toBeUndefined();
    });

    it("returns undefined when frontmatter has no closing ---", () => {
      expect(splitFrontmatter("---\nname: no-close", false)).toBeUndefined();
    });
  });

  describe("validateFrontmatter", () => {
    describe("blocks (TOML)", () => {
      it("passes for valid TOML frontmatter", () => {
        expect(() => {
          validateFrontmatter('+++\ndescription="My block"\n+++\n', true);
        }).not.toThrow();
      });

      it("passes for minimal valid TOML (empty description)", () => {
        expect(() => {
          validateFrontmatter('+++\ndescription=""\n+++\n', true);
        }).not.toThrow();
      });

      it("throws for missing opening +++.+.", () => {
        expect(() => {
          validateFrontmatter('description="no delims"\n', true);
        }).toThrow("Invalid frontmatter: expected file to start with '+++'");
      });

      it("throws for missing closing +++.+.", () => {
        expect(() => {
          validateFrontmatter('+++\ndescription="no close"', true);
        }).toThrow("Invalid frontmatter: missing closing '+++'");
      });

      it("throws for invalid TOML syntax", () => {
        expect(() => {
          validateFrontmatter("+++\nnot-valid-toml-[[[\n+++\n", true);
        }).toThrow(/Invalid frontmatter/u);
      });

      it("throws when description field is missing", () => {
        expect(() => {
          validateFrontmatter("+++\nother=42\n+++\n", true);
        }).toThrow(/Invalid frontmatter/u);
      });

      it("throws when description has wrong type", () => {
        expect(() => {
          validateFrontmatter("+++\ndescription=42\n+++\n", true);
        }).toThrow(/Invalid frontmatter/u);
      });
    });

    describe("skills (YAML)", () => {
      it("passes for valid YAML frontmatter", () => {
        expect(() => {
          validateFrontmatter("---\nname: my-skill\ndescription: A test skill\n---\n", false);
        }).not.toThrow();
      });

      it("throws for missing opening ---", () => {
        expect(() => {
          validateFrontmatter("name: my-skill\ndescription: A test\n", false);
        }).toThrow("Invalid frontmatter: expected file to start with '---'");
      });

      it("throws for missing closing ---", () => {
        expect(() => {
          validateFrontmatter("---\nname: my-skill\ndescription: A test", false);
        }).toThrow("Invalid frontmatter: missing closing '---'");
      });

      it("throws when name field is missing", () => {
        expect(() => {
          validateFrontmatter("---\ndescription: A test skill\n---\n", false);
        }).toThrow(/Invalid frontmatter/u);
      });

      it("throws when description field is missing", () => {
        expect(() => {
          validateFrontmatter("---\nname: my-skill\n---\n", false);
        }).toThrow(/Invalid frontmatter/u);
      });

      it("throws when name is empty", () => {
        expect(() => {
          validateFrontmatter('---\nname: ""\ndescription: A test skill\n---\n', false);
        }).toThrow(/Invalid frontmatter/u);
      });

      it("throws when description is empty", () => {
        expect(() => {
          validateFrontmatter('---\nname: my-skill\ndescription: ""\n---\n', false);
        }).toThrow(/Invalid frontmatter/u);
      });
    });
  });
});
