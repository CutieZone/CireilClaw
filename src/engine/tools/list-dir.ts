import { readdir } from "node:fs/promises";

import { loadTools } from "$/config/index.js";
import type { ExecToolConfigSchema } from "$/config/schemas.js";
import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import { checkConditionalAccess, sandboxToReal, validateSystemPath } from "$/util/paths.js";
import * as vb from "valibot";

const AGENT_SANDBOX_PREFIXES = ["/workspace", "/memories", "/blocks", "/skills", "/tasks"] as const;

function isExecConfig(value: unknown): value is vb.InferOutput<typeof ExecToolConfigSchema> {
  return typeof value === "object" && value !== null && "binaries" in value;
}

const Schema = vb.strictObject({
  path: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description(
      "Directory path to list. Sandbox paths (e.g. /workspace/) or exec-visible system paths (e.g. /usr, /nix). Use /bin to list available exec binaries.",
    ),
  ),
});

export const listDir: ToolDef = {
  description:
    "List the files and subdirectories at the given path. Returns each entry's name and type (file, directory, or symlink).\n\n" +
    "Allowed path roots: /workspace/, /memories/, /blocks/, /skills/, /usr/, /lib/, /lib64/, /nix/.\n" +
    "Note that paths used here *must* be absolute.\n\n" +
    "Use /bin to list the binaries available in the exec sandbox (derived from tools config, not the host filesystem).\n\n" +
    "Use this to explore directory structure before reading or writing specific files.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(Schema, input);

    // /bin is synthetic in the exec sandbox, so just return configured binaries directly
    if (data.path === "/bin") {
      const toolsConfig = await loadTools(ctx.agentSlug);
      const execConfig = toolsConfig["exec"];

      if (execConfig === false || !isExecConfig(execConfig) || !execConfig.enabled) {
        return { entries: [], path: data.path, success: true };
      }

      const items = execConfig.binaries.map((name) => ({ name, type: "symlink" as const }));
      return { entries: items, path: data.path, success: true };
    }

    const isAgentPath = AGENT_SANDBOX_PREFIXES.some(
      (prefix) => data.path === prefix || data.path.startsWith(`${prefix}/`),
    );

    const realPath: string = isAgentPath
      ? sandboxToReal(data.path, ctx.agentSlug)
      : validateSystemPath(data.path);

    // Check conditional access rules for agent sandbox paths only
    if (isAgentPath && ctx.conditions !== undefined) {
      checkConditionalAccess(data.path, ctx.agentSlug, ctx.conditions, ctx.session);
    }

    const entries = await readdir(realPath, { withFileTypes: true });
    const items = entries.map((ent): { name: string; type: "directory" | "symlink" | "file" } => ({
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
    }));
    return { entries: items, path: data.path, success: true };
  },
  name: "list-dir",
  parameters: Schema,
};
