import { readdir } from "node:fs/promises";

import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import {
  checkConditionalAccess,
  getMountEntriesAtPath,
  sandboxToReal,
  validateSystemPath,
} from "$/util/paths.js";
import * as vb from "valibot";

const AGENT_SANDBOX_PREFIXES = ["/workspace", "/memories", "/blocks", "/skills", "/tasks"] as const;

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
      const execConfig = ctx.cfg.exec;

      if (execConfig === false || !execConfig.enabled) {
        return { entries: [], path: data.path, success: true };
      }

      const items = execConfig.binaries.map((name) => ({ name, type: "symlink" as const }));
      return { entries: items, path: data.path, success: true };
    }

    const isAgentPath = AGENT_SANDBOX_PREFIXES.some(
      (prefix) => data.path === prefix || data.path.startsWith(`${prefix}/`),
    );

    const realPath: string = isAgentPath
      ? sandboxToReal(data.path, ctx.agentSlug, ctx.mounts)
      : validateSystemPath(data.path);

    // Check conditional access rules for agent sandbox paths only
    if (isAgentPath && ctx.conditions !== undefined) {
      checkConditionalAccess(data.path, ctx.agentSlug, ctx.conditions, ctx.session);
    }

    const items: { name: string; type: "directory" | "symlink" | "file" }[] = [];

    try {
      const entries = await readdir(realPath, { withFileTypes: true });
      for (const ent of entries) {
        const type = ((): "directory" | "symlink" | "file" => {
          if (ent.isDirectory()) {
            return "directory";
          }
          if (ent.isSymbolicLink()) {
            return "symlink";
          }
          return "file";
        })();
        items.push({ name: ent.name, type });
      }
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? (error as { code: unknown }).code : undefined;
      // Only swallow ENOENT for workspace paths that may have mount entries.
      if (!isAgentPath || code !== "ENOENT") {
        throw error;
      }
    }

    // Merge synthetic mount entries for workspace paths. Mounts shadow physical entries.
    if (isAgentPath && ctx.mounts !== undefined && ctx.mounts.length > 0) {
      const mountItems = getMountEntriesAtPath(data.path, ctx.mounts);
      const mountNames = new Set(mountItems.map((mountItem) => mountItem.name));
      const filtered = items.filter((item) => !mountNames.has(item.name));
      items.length = 0;
      items.push(...filtered, ...mountItems);
    }

    return { entries: items, path: data.path, success: true };
  },
  name: "list-dir",
  parameters: Schema,
};
