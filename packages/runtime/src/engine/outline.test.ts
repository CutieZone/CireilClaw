import { describe, expect, test } from "vitest";

import { generateOutlineFromContent, registerExtractor, getExtractors } from "#engine/outline.js";

// Mock sandboxToReal for testing — outline generation needs a real path,
// but we inject content directly to avoid filesystem dependency.
// We can't import sandboxToReal without filesystem, so we test the extractor
// functions directly through a thin wrapper.

describe("outline", () => {
  describe("markdown extractor", () => {
    test("extracts ATX headings from a document", () => {
      const content = `# Overview
Some text here.

## Prerequisites
More text.

### System Requirements
Even more text.

## Installation
Install steps here.

# Appendix
Final section.
${"padding\n".repeat(1200)}`;

      const outline = generateOutlineFromContent("/workspace/test.md", content);

      expect(outline).toBeDefined();
      expect(outline!.path).toBe("/workspace/test.md");
      expect(outline!.sections).toHaveLength(5);

      const ids = outline!.sections.map((s) => s.id);
      expect(ids).toContain("overview");
      expect(ids).toContain("prerequisites");
      expect(ids).toContain("system-requirements");
      expect(ids).toContain("installation");
      expect(ids).toContain("appendix");
    });

    test("returns undefined for small files", async () => {
      const content = "# Tiny\nJust a small file.";
      const outline = generateOutlineFromContent("/workspace/tiny.md", content);

      // File is under the 2000-token threshold
      expect(outline).toBeUndefined();
    });

    test("returns undefined for non-markdown files without extractor", async () => {
      const content = "function foo() {\n  return 1;\n}".repeat(500);
      const outline = generateOutlineFromContent("/workspace/code.ts", content);

      // No extractor registered for .ts files
      expect(outline).toBeUndefined();
    });

    test("sections have correct line numbers", () => {
      const content = `line 1
# First
line 3
line 4
## Second
line 6
line 7
# Third
line 9\n${"padding\n".repeat(1200)}`;

      const outline = generateOutlineFromContent("/workspace/lines.md", content);

      expect(outline).toBeDefined();
      const { sections } = outline!;

      const first = sections.find((s) => s.id === "first");
      const second = sections.find((s) => s.id === "second");
      const third = sections.find((s) => s.id === "third");

      expect(first?.line).toBe(2);
      expect(second?.line).toBe(5);
      expect(third?.line).toBe(8);
    });

    test("strips markdown links from heading text", () => {
      const content = `# [Installation Guide](docs/install.md)\n\nContent here.\n${"padding\n".repeat(1200)}`;
      const outline = generateOutlineFromContent("/workspace/links.md", content);

      expect(outline).toBeDefined();
      const heading = outline!.sections.find((s) => s.id === "installation-guide");
      expect(heading).toBeDefined();
      expect(heading!.label).toBe("Installation Guide");
    });
  });

  describe("XML extractor", () => {
    test("extracts top-level elements with id attributes", async () => {
      const content = `<root>
  <section id="intro">
    Introduction content here.
  </section>
  <section id="main">
    Main content.
  </section>
  <section id="conclusion">
    Conclusion.
  </section>
</root>`.repeat(50); // Make it large enough to trigger outline

      const outline = generateOutlineFromContent("/workspace/doc.xml", content);

      expect(outline).toBeDefined();
      const ids = outline!.sections.map((s) => s.id);
      expect(ids).toContain("intro");
      expect(ids).toContain("main");
      expect(ids).toContain("conclusion");
    });
  });

  describe("extractor registration", () => {
    test("registers and retrieves custom extractors", () => {
      const initialCount = getExtractors().length;

      registerExtractor({
        extract: () => [],
        glob: "*.custom",
        priority: 100,
      });

      const extractors = getExtractors();
      expect(extractors.length).toBe(initialCount + 1);
      // Highest priority extractor should be first
      expect(extractors[0]!.priority).toBe(100);
    });
  });
});
