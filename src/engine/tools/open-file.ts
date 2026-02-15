import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";

import { sandboxToReal, sanitizeError } from "$/util/paths.js";
import { access } from "node:fs/promises";
import * as vb from "valibot";

const Schema = vb.strictObject({
  path: vb.pipe(vb.string(), vb.nonEmpty()),
});

export const openFile: ToolDef = {
  description:
    "Add a file to the context window so its contents are always visible in the system prompt. " +
    "Use this for files you'll be editing repeatedly. Prefer `read` for one-off reads.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    try {
      const data = vb.parse(Schema, input);
      const realPath = sandboxToReal(data.path, ctx.agentSlug);
      // Verify the file actually exists before pinning it.
      await access(realPath);
      ctx.session.openedFiles.add(data.path);
      return { open: [...ctx.session.openedFiles], path: data.path, success: true };
    } catch (error: unknown) {
      if (error instanceof vb.ValiError) {
        return { error: error.message, issues: error.issues, success: false };
      }
      return { error: sanitizeError(error, ctx.agentSlug), success: false };
    }
  },
  name: "open-file",
  parameters: Schema,
};
