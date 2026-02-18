import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import * as vb from "valibot";

const Schema = vb.strictObject({
  path: vb.pipe(vb.string(), vb.nonEmpty()),
});

export const closeFile: ToolDef = {
  description:
    "Unpin a file from the system prompt. Its contents will no longer be included in subsequent turns.\n\n" +
    "Call this when you are done working with a pinned file to free context space. Has no effect if the file is not currently pinned.",
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
