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
        "Add all remaining sections from the file outline. Mutually exclusive with `sections`.",
      ),
    ),
  ),
  path: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("Sandbox path of a previously opened file with sections."),
  ),
  sections: vb.exactOptional(
    vb.pipe(
      vb.array(vb.pipe(vb.string(), vb.nonEmpty())),
      vb.minLength(1),
      vb.description("Section IDs to add to the active set for this file."),
    ),
  ),
});

export const readSections: ToolDef = {
  description:
    "Add specific sections of an already-opened file to the active context. The file must have been opened via `open-file` and have an outline (i.e. be large enough to trigger outline generation).\n\n" +
    "Use this when you opened only some sections and later need additional ones. The section IDs come from the file outline returned by `read`. " +
    "Alternatively, use `all` to add every remaining section at once.\n\n" +
    "When to use:\n" +
    "- You opened a large file with `open-file` using `sections` and realize you need more context.\n" +
    "- You want to incrementally load sections of a large document.\n\n" +
    "When NOT to use:\n" +
    "- To remove sections — use `open-file` with `closeSections`.\n" +
    "- To read a file one-time — use `read`.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(Schema, input);

    if (data.all === true && data.sections !== undefined) {
      throw new ToolError(
        "`all` is mutually exclusive with `sections`.",
        "Use `all` alone, or provide a list of `sections` instead.",
      );
    }

    if (data.all !== true && data.sections === undefined) {
      throw new ToolError(
        "Either `sections` or `all` must be provided.",
        "Specify section IDs to add, or set `all` to true to add every remaining section.",
      );
    }

    const realPath = await ctx.paths.resolve(data.path);

    await ctx.paths.checkConditionalAccess(data.path);

    if (!ctx.session.openedFiles.has(data.path)) {
      return {
        error: `File '${data.path}' is not open. Use 'open-file' first.`,
        path: data.path,
        success: false,
      };
    }

    const { size } = await stat(realPath);
    const content = await readFile(realPath, "utf8");
    const outline = await generateOutline(data.path, ctx.agentSlug, content);

    if (outline === undefined) {
      return {
        message: `File '${data.path}' is below the outline threshold — the entire file is already in context.`,
        path: data.path,
        success: true,
      };
    }

    const validIds = new Set(outline.sections.map((section) => section.id));
    const existing = ctx.session.activeFileSections.get(data.path);
    const added: string[] = [];

    if (data.all === true) {
      added.push(...[...validIds].filter((id) => !(existing?.has(id) ?? false)));
    } else if (data.sections === undefined) {
      // Unreachable due to validation above, but satisfies the linter
    } else {
      const invalid = data.sections.filter((id) => !validIds.has(id));
      if (invalid.length > 0) {
        return {
          error: `Unknown section(s): ${invalid.join(", ")}. Available sections: ${[...validIds].join(", ")}`,
          path: data.path,
          success: false,
        };
      }
      added.push(...data.sections.filter((id) => !(existing?.has(id) ?? false)));
    }

    if (added.length === 0) {
      return {
        activeSections: [...(existing ?? new Set())],
        added: [],
        message: "All sections are already active.",
        path: data.path,
        size,
        success: true,
      };
    }

    if (existing === undefined) {
      ctx.session.activeFileSections.set(data.path, new Set(added));
    } else {
      for (const sectionId of added) {
        existing.add(sectionId);
      }
    }

    return {
      activeSections: [...(ctx.session.activeFileSections.get(data.path) ?? new Set())],
      added,
      path: data.path,
      size,
      success: true,
    };
  },
  name: "read-sections",
  parameters: Schema,
};
