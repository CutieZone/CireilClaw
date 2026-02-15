import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";

import * as vb from "valibot";

const Schema = vb.strictObject({
  path: vb.pipe(vb.string(), vb.nonEmpty()),
});

export const closeFile: ToolDef = {
  description:
    "Remove a file from the context window. Its contents will no longer appear in the system prompt.",
  // oxlint-disable-next-line typescript/require-await
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    try {
      const data = vb.parse(Schema, input);
      const removed = ctx.session.openedFiles.delete(data.path);
      return { open: [...ctx.session.openedFiles], path: data.path, removed, success: true };
    } catch (error: unknown) {
      if (error instanceof vb.ValiError) {
        return { error: error.message, issues: error.issues, success: false };
      }
      return { error: String(error), success: false };
    }
  },
  name: "close-file",
  parameters: Schema,
};
