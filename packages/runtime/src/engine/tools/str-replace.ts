import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import * as vb from "valibot";

import { ToolError } from "#engine/errors.js";
import type { ToolContext, ToolDef } from "#engine/tools/tool-def.js";
import { requiresFrontmatter, splitFrontmatter, validateFrontmatter } from "#util/frontmatter.js";

const Schema = vb.strictObject({
  new_text: vb.pipe(
    vb.string(),
    vb.description("Replacement text. Pass an empty string to delete old_text."),
  ),
  old_text: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description(
      "Exact literal string to find. Whitespace, indentation, and newlines all matter.",
    ),
  ),
  path: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("Sandbox path of the file to edit (e.g. /workspace/main.ts)."),
  ),
});

// oxlint-disable-next-line sort-keys
export const strReplace: ToolDef = {
  name: "str-replace",
  parameters: Schema,
  description:
    "Find and replace exactly one occurrence of a literal string in an existing file.\n\n" +
    "`old_text` must be non-empty; `new_text` may be empty to delete. The match is exact — whitespace, indentation, and newlines all matter. On success, returns a few lines of context around the replacement.\n\n" +
    "For files under /blocks/ and /skills/, search happens within the body only — the required frontmatter is transparently preserved and never matched or modified.\n\n" +
    "Error conditions:\n" +
    "- `old_text` not found in the body → include more surrounding context to verify your match.\n" +
    "- `old_text` found more than once → include additional surrounding lines to disambiguate.\n\n" +
    "Tip: Use `read` or `open-file` first to see the current file contents and craft an accurate match.\n\n" +
    "When NOT to use:\n" +
    "- Creating new files or rewriting an entire file — use `write` instead.\n" +
    "- The file doesn't exist yet — use `write` instead.\n\n" +
    "Note that paths used here *must* be absolute.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(Schema, input);

    const path = await ctx.paths.resolve(data.path);

    await ctx.paths.checkConditionalAccess(data.path);
    await ctx.paths.checkWriteAccess(data.path);

    if (!existsSync(path)) {
      throw new ToolError(
        `File at ${data.path} does not exist.`,
        "Did you mean to use the 'write' tool?",
      );
    }

    const content = await readFile(path, "utf8");

    // For files with required frontmatter (blocks, skills), extract the frontmatter
    // and search/replace within the body only. The frontmatter is transparently
    // preserved so the agent never accidentally corrupts it.
    let searchContent = content;
    let frontmatter: string | undefined = undefined;

    if (requiresFrontmatter(data.path)) {
      const split = splitFrontmatter(content, data.path.startsWith("/blocks/"));
      if (split !== undefined) {
        ({ frontmatter, body: searchContent } = split);
      }
    }

    if (!searchContent.includes(data.old_text)) {
      throw new ToolError(`File does not contain old_text`);
    }

    let instances = 0;
    let idx: number | undefined = undefined;

    while ((idx = searchContent.indexOf(data.old_text, idx)) !== -1) {
      instances++;
      idx += data.old_text.length;
    }

    if (instances > 1) {
      throw new ToolError(
        `File contains ${instances} instances of old_text.`,
        "Add more context to get a precise match.",
      );
    }

    const newContent =
      frontmatter === undefined
        ? content.replace(data.old_text, () => data.new_text)
        : frontmatter + searchContent.replace(data.old_text, () => data.new_text);

    // Validate preserved frontmatter before writing — catches pre-existing
    // corruption so the agent gets immediate feedback instead of a load failure later.
    if (frontmatter !== undefined) {
      validateFrontmatter(frontmatter, data.path.startsWith("/blocks/"));
    }

    await writeFile(path, newContent, "utf8");

    // Invalidate section cache — file content changed
    ctx.session.activeFileSections.delete(data.path);

    const oldTextPos =
      frontmatter === undefined
        ? content.indexOf(data.old_text)
        : frontmatter.length + searchContent.indexOf(data.old_text);
    const lineIndex = newContent.slice(0, oldTextPos).split("\n").length;
    const contextLines = 2;
    const newLines = newContent.split("\n");
    const contextStart = Math.max(0, lineIndex - contextLines - 1);
    const contextEnd = Math.min(newLines.length, lineIndex + contextLines);

    return {
      context: newLines.slice(contextStart, contextEnd).join("\n"),
      success: true,
    };
  },
};
