import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";

import { sandboxToReal, sanitizeError } from "$/util/paths.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as vb from "valibot";

// oxlint-disable-next-line typescript-eslint/no-unsafe-assignment -- valibot custom validation
const Schema = vb.strictObject({
  content: vb.string(),
  path: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.custom((input: string) => {
      if (input.startsWith("/blocks/") && !input.endsWith(".md")) {
        return "Files in /blocks/ must end with .md extension";
      }
      return true;
    }),
  ),
});

export const write: ToolDef = {
  description:
    "Create or overwrite a file with the given content. " +
    "Parent directories are created automatically. " +
    "For surgical edits to existing files, prefer `str-replace` instead.",
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
