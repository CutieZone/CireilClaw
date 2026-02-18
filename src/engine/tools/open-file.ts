import { access } from "node:fs/promises";

import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import { sandboxToReal, sanitizeError } from "$/util/paths.js";
import * as vb from "valibot";

const Schema = vb.strictObject({
  path: vb.pipe(vb.string(), vb.nonEmpty()),
});

export const openFile: ToolDef = {
  description:
    "Pin a file to the system prompt so its full contents are included in every subsequent turn. The file stays pinned until you call `close-file`.\n\n" +
    "When to use:\n" +
    "- You need to reference or edit a file across multiple turns and want its contents always visible.\n\n" +
    "When NOT to use:\n" +
    "- You only need to see a file once — use `read` instead to avoid wasting context space.\n\n" +
    "The file must exist at the given path. Allowed path roots: /workspace/, /memories/, /blocks/, /skills/.",
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
