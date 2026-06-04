import { readFile, stat } from "node:fs/promises";

import * as vb from "valibot";

import { ToolError } from "#engine/errors.js";
import { generateOutline } from "#engine/outline.js";
import type { ToolContext, ToolDef } from "#engine/tools/tool-def.js";

const Schema = vb.strictObject({
  all: vb.exactOptional(
    vb.pipe(
      vb.boolean(),
      vb.description(
        "Open all sections from the file outline. Mutually exclusive with `sections` and `closeSections`.",
      ),
    ),
  ),
  closeSections: vb.exactOptional(
    vb.pipe(
      vb.array(vb.pipe(vb.string(), vb.nonEmpty())),
      vb.minLength(1),
      vb.description("Section IDs to close. Removes previously opened sections from context."),
    ),
  ),
  path: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("Sandbox path to pin (e.g. /workspace/config.json)."),
  ),
  sections: vb.exactOptional(
    vb.pipe(
      vb.array(vb.pipe(vb.string(), vb.nonEmpty())),
      vb.minLength(1),
      vb.description(
        "Section IDs to open from the file outline. If omitted, the entire file is opened.",
      ),
    ),
  ),
});

export const openFile: ToolDef = {
  description:
    "Pin a file to the system prompt so its full contents are included in every subsequent turn. The file stays pinned until you call `close-file`.\n\n" +
    "For large files, you can provide `sections` to open only specific sections from the file outline (as returned by `read`), or use `all` to open every section at once. " +
    "Use `closeSections` to remove sections without closing the entire file. If `sections` is omitted, the entire file is pinned.\n\n" +
    "When to use:\n" +
    "- You need to reference or edit a file across multiple turns and want its contents always visible.\n\n" +
    "When NOT to use:\n" +
    "- You only need to see a file once — use `read` instead to avoid wasting context space.\n\n" +
    "The file must exist at the given path. Allowed path roots: /workspace/, /memories/, /blocks/, /skills/.\n" +
    "Note that paths used here *must* be absolute.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(Schema, input);

    if (data.all === true && (data.sections !== undefined || data.closeSections !== undefined)) {
      throw new ToolError(
        "`all` is mutually exclusive with `sections` and `closeSections`.",
        "Use `all` alone, or use `sections` / `closeSections` instead.",
      );
    }

    const realPath = await ctx.paths.resolve(data.path);

    await ctx.paths.checkConditionalAccess(data.path);

    // Verify the file actually exists before pinning it.
    const stats = await stat(realPath);
    if (!stats.isFile()) {
      throw new ToolError(
        "Path is a directory or not a standard file.",
        "Only files can be pinned.",
      );
    }

    if (data.closeSections !== undefined && data.closeSections.length > 0) {
      const existing = ctx.session.activeFileSections.get(data.path);
      if (existing !== undefined) {
        for (const sectionId of data.closeSections) {
          existing.delete(sectionId);
        }
        if (existing.size === 0) {
          ctx.session.activeFileSections.delete(data.path);
        }
      }
      return {
        activeSections: [...(ctx.session.activeFileSections.get(data.path) ?? new Set())],
        path: data.path,
        success: true,
      };
    }

    ctx.session.openedFiles.add(data.path);

    if (data.all === true) {
      const content = await readFile(realPath, "utf8");
      const outline = await generateOutline(data.path, ctx.agentSlug, content);
      if (outline === undefined) {
        // File is small enough — just open the whole thing
        ctx.session.activeFileSections.delete(data.path);
      } else {
        ctx.session.activeFileSections.set(
          data.path,
          new Set(outline.sections.map((section) => section.id)),
        );
      }
    } else if (data.sections !== undefined && data.sections.length > 0) {
      const content = await readFile(realPath, "utf8");
      const outline = await generateOutline(data.path, ctx.agentSlug, content);
      if (outline === undefined) {
        // File is small enough — just open the whole thing
        ctx.session.activeFileSections.delete(data.path);
      } else {
        const validIds = new Set(outline.sections.map((section) => section.id));
        const invalid = data.sections.filter((id) => !validIds.has(id));
        if (invalid.length > 0) {
          throw new ToolError(
            `Unknown section(s): ${invalid.join(", ")}. Available sections: ${[...validIds].join(", ")}`,
            `Use the section IDs from the file outline.`,
          );
        }
        ctx.session.activeFileSections.set(data.path, new Set(data.sections));
      }
    } else {
      ctx.session.activeFileSections.delete(data.path);
    }

    const activeSections = ctx.session.activeFileSections.get(data.path);

    return {
      activeSections: activeSections === undefined ? undefined : [...activeSections],
      open: [...ctx.session.openedFiles],
      path: data.path,
      success: true,
    };
  },
  name: "open-file",
  parameters: Schema,
};
