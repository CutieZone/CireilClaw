import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import { sandboxToReal, sanitizeError } from "$/util/paths.js";
import * as vb from "valibot";

// oxlint-disable-next-line typescript-eslint/no-unsafe-assignment -- valibot custom validation
const Schema = vb.strictObject({
  content: vb.string(),
  path: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.custom((input: unknown) => {
      if (typeof input === "string" && input.startsWith("/blocks/") && !input.endsWith(".md")) {
        return false;
      }
      return true;
    }, "Files in /blocks/ must end with .md extension"),
  ),
});

export const write: ToolDef = {
  description:
    "Create a new file or completely overwrite an existing file with the provided content.\n\n" +
    "Parent directories are created automatically if they don't exist.\n\n" +
    "Constraints:\n" +
    "- Files under /blocks/ must have a .md extension.\n" +
    "- Allowed path roots: /workspace/, /memories/, /blocks/, /skills/.\n\n" +
    "When to use:\n" +
    "- Creating new files from scratch.\n" +
    "- Replacing the entire contents of a file.\n\n" +
    "When NOT to use:\n" +
    "- Making small, targeted changes to an existing file — use `str-replace` instead, which is safer and preserves surrounding content.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    try {
      const data = vb.parse(Schema, input);
      const realPath = sandboxToReal(data.path, ctx.agentSlug);
      await mkdir(dirname(realPath), { recursive: true });
      await writeFile(realPath, data.content, "utf8");
      return { path: data.path, success: true };
    } catch (error: unknown) {
      if (error instanceof vb.ValiError) {
        return { error: error.message, issues: error.issues, success: false };
      }
      return {
        error: sanitizeError(error, ctx.agentSlug),
        success: false,
      };
    }
  },
  name: "write",
  parameters: Schema,
};
