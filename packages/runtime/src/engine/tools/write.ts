import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import * as vb from "valibot";

import type { ToolContext, ToolDef } from "#engine/tools/tool-def.js";
import { requiresFrontmatter, splitFrontmatter } from "#util/frontmatter.js";

const Schema = vb.strictObject({
  content: vb.pipe(
    vb.string(),
    vb.description("File content to write. May be empty string to create an empty file."),
  ),
  path: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.custom((input: unknown) => {
      if (
        typeof input === "string" &&
        (input === "/blocks" || input.startsWith("/blocks/")) &&
        !input.endsWith(".md")
      ) {
        return false;
      }
      return true;
    }, "Files in /blocks/ must end with .md extension"),
    vb.description(
      "Sandbox path to write (e.g. /workspace/output.txt). Files in /blocks/ must end with .md.",
    ),
  ),
});

export const write: ToolDef = {
  description:
    "Create a new file or completely overwrite an existing file with the provided content.\n\n" +
    "Parent directories are created automatically if they don't exist.\n\n" +
    "Constraints:\n" +
    "- Files under /blocks/ must have a .md extension.\n" +
    "- Allowed path roots: /workspace/, /memories/, /blocks/, /skills/.\n" +
    "- For existing files under /blocks/ and /skills/, the existing frontmatter is auto-preserved when the provided content does not include frontmatter.\n" +
    "Note that paths used here *must* be absolute.\n\n" +
    "When to use:\n" +
    "- Creating new files from scratch.\n" +
    "- Replacing the entire contents of a file.\n\n" +
    "When NOT to use:\n" +
    "- Making small, targeted changes to an existing file — use `str-replace` instead, which is safer and preserves surrounding content.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(Schema, input);
    const realPath = await ctx.paths.resolve(data.path);

    await ctx.paths.checkConditionalAccess(data.path);
    await ctx.paths.checkWriteAccess(data.path);

    let { content } = data;

    // When overwriting an existing block/skill file that requires frontmatter,
    // preserve the existing frontmatter if the new content doesn't include it.
    if (requiresFrontmatter(data.path) && existsSync(realPath)) {
      const existing = await readFile(realPath, "utf8");
      const isBlock = data.path.startsWith("/blocks/");
      const split = splitFrontmatter(existing, isBlock);
      if (split !== undefined) {
        const { frontmatter } = split;
        const delim = isBlock ? "+++" : "---";
        if (!data.content.startsWith(delim)) {
          content = frontmatter + data.content;
        }
      }
    }

    await mkdir(path.dirname(realPath), { recursive: true });
    await writeFile(realPath, content, "utf8");

    // Invalidate section cache — file content changed
    ctx.session.activeFileSections.delete(data.path);

    return { path: data.path, success: true };
  },
  name: "write",
  parameters: Schema,
};
