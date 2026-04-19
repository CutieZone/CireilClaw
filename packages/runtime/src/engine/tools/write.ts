import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import { checkConditionalAccess, checkMountWriteAccess, sandboxToReal } from "$/util/paths.js";
import * as vb from "valibot";

const Schema = vb.strictObject({
  content: vb.pipe(
    vb.string(),
    vb.description("File content to write. May be empty string to create an empty file."),
  ),
  path: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.custom((input: unknown) => {
      if (typeof input === "string" && input.startsWith("/blocks/") && !input.endsWith(".md")) {
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
    "Note that paths used here *must* be absolute.\n\n" +
    "When to use:\n" +
    "- Creating new files from scratch.\n" +
    "- Replacing the entire contents of a file.\n\n" +
    "When NOT to use:\n" +
    "- Making small, targeted changes to an existing file — use `str-replace` instead, which is safer and preserves surrounding content.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(Schema, input);
    const realPath = sandboxToReal(data.path, ctx.agentSlug, ctx.mounts);

    // Check conditional access rules if conditions are available
    if (ctx.conditions !== undefined) {
      checkConditionalAccess(data.path, ctx.agentSlug, ctx.conditions, ctx.session);
    }

    if (ctx.mounts !== undefined && ctx.mounts.length > 0) {
      checkMountWriteAccess(data.path, ctx.mounts);
    }

    await mkdir(dirname(realPath), { recursive: true });
    await writeFile(realPath, data.content, "utf8");
    return { path: data.path, success: true };
  },
  name: "write",
  parameters: Schema,
};
