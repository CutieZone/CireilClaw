import { stat } from "node:fs/promises";

import * as vb from "valibot";

import { ToolError } from "#engine/errors.js";
import type { ToolContext, ToolDef } from "#engine/tools/tool-def.js";
import { checkConditionalAccess, sandboxToReal } from "#util/paths.js";

const Schema = vb.strictObject({
  path: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("Sandbox path to pin (e.g. /workspace/config.json)."),
  ),
});

export const openFile: ToolDef = {
  description:
    "Pin a file to the system prompt so its full contents are included in every subsequent turn. The file stays pinned until you call `close-file`.\n\n" +
    "When to use:\n" +
    "- You need to reference or edit a file across multiple turns and want its contents always visible.\n\n" +
    "When NOT to use:\n" +
    "- You only need to see a file once — use `read` instead to avoid wasting context space.\n\n" +
    "The file must exist at the given path. Allowed path roots: /workspace/, /memories/, /blocks/, /skills/.\n" +
    "Note that paths used here *must* be absolute.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(Schema, input);
    const realPath = sandboxToReal(data.path, ctx.agentSlug, ctx.mounts);

    // Check conditional access rules if conditions are available
    if (ctx.conditions !== undefined) {
      checkConditionalAccess(data.path, ctx.agentSlug, ctx.conditions, ctx.session);
    }

    // Verify the file actually exists before pinning it.
    const stats = await stat(realPath);
    if (!stats.isFile()) {
      throw new ToolError(
        "Path is a directory or not a standard file.",
        "Only files can be pinned.",
      );
    }

    ctx.session.openedFiles.add(data.path);
    return { open: [...ctx.session.openedFiles], path: data.path, success: true };
  },
  name: "open-file",
  parameters: Schema,
};
