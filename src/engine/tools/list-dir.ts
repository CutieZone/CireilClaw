import { readdir } from "node:fs/promises";

import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import { sandboxToReal, sanitizeError } from "$/util/paths.js";
import * as vb from "valibot";

const Schema = vb.strictObject({
  path: vb.pipe(vb.string(), vb.nonEmpty()),
});

export const listDir: ToolDef = {
  description:
    "List the files and subdirectories at the given sandbox path. Returns each entry's name and type (file, directory, or symlink).\n\n" +
    "Allowed path roots: /workspace/, /memories/, /blocks/, /skills/.\n\n" +
    "Use this to explore directory structure before reading or writing specific files.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    try {
      const data = vb.parse(Schema, input);
      const realPath = sandboxToReal(data.path, ctx.agentSlug);
      const entries = await readdir(realPath, { withFileTypes: true });
      const items = entries.map(
        (ent): { name: string; type: "directory" | "symlink" | "file" } => ({
          name: ent.name,
          type: ((): "directory" | "symlink" | "file" => {
            if (ent.isDirectory()) {
              return "directory";
            }
            if (ent.isSymbolicLink()) {
              return "symlink";
            }
            return "file";
          })(),
        }),
      );
      return { entries: items, path: data.path, success: true };
    } catch (error: unknown) {
      if (error instanceof vb.ValiError) {
        return { error: error.message, issues: error.issues, success: false };
      }
      return { error: sanitizeError(error, ctx.agentSlug), success: false };
    }
  },
  name: "list-dir",
  parameters: Schema,
};
