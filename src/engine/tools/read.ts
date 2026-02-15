import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";

import { sandboxToReal, sanitizeError } from "$/util/paths.js";
import { readFile, stat } from "node:fs/promises";
import * as vb from "valibot";

const Schema = vb.strictObject({
  path: vb.pipe(vb.string(), vb.nonEmpty()),
});

export const read: ToolDef = {
  description: "Read the full contents of a file within the sandbox.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    try {
      const data = vb.parse(Schema, input);
      const realPath = sandboxToReal(data.path, ctx.agentSlug);
      const [content, { size }] = await Promise.all([readFile(realPath, "utf8"), stat(realPath)]);
      return { content, path: data.path, size, success: true };
    } catch (error: unknown) {
      if (error instanceof vb.ValiError) {
        return { error: error.message, issues: error.issues, success: false };
      }
      return { error: sanitizeError(error, ctx.agentSlug), success: false };
    }
  },
  name: "read",
  parameters: Schema,
};
