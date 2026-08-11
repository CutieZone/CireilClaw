import { readdir } from "node:fs/promises";

import * as vb from "valibot";

import type { ToolContext, ToolDef } from "#engine/tools/tool-def.js";
import { getMountEntriesAtPath, validateSystemPath } from "#util/paths.js";

const AGENT_SANDBOX_PREFIXES = ["/workspace", "/memories", "/blocks", "/skills", "/tasks"] as const;

const Schema = vb.strictObject({
  path: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description(
      "Directory path to list. Sandbox paths (e.g. /workspace/) or exec-visible system paths (e.g. /usr, /nix). With Bubblewrap, use /bin to list configured binaries.",
    ),
  ),
});

export const listDir: ToolDef = {
  description:
    "List the files and subdirectories at the given path. Returns each entry's name and type (file, directory, or symlink).\n\n" +
    "Allowed path roots: /workspace/, /memories/, /blocks/, /skills/, /usr/, /lib/, /lib64/, /nix/.\n" +
    "Note that paths used here *must* be absolute.\n\n" +
    "With Bubblewrap, use /bin to list configured sandbox binaries. Incus containers use their installed image binaries; use exec with ls /bin to inspect them.\n\n" +
    "Use this to explore directory structure before reading or writing specific files.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(Schema, input);

    // /bin is synthetic only in the Bubblewrap sandbox.
    if (data.path === "/bin") {
      if (ctx.cfg.sandbox.backend === "incus") {
        return {
          entries: [],
          error: "Use exec with ls /bin to inspect binaries installed in the Incus image.",
          path: data.path,
          success: false,
        };
      }

      if (ctx.cfg.exec === false || !ctx.cfg.exec.enabled) {
        return { entries: [], path: data.path, success: true };
      }

      const items = (ctx.cfg.sandbox.bwrap?.binaries ?? []).map((name) => ({
        name,
        type: "symlink" as const,
      }));
      return { entries: items, path: data.path, success: true };
    }

    const isAgentPath = AGENT_SANDBOX_PREFIXES.some(
      (prefix) => data.path === prefix || data.path.startsWith(`${prefix}/`),
    );

    const realPath: string = isAgentPath
      ? await ctx.paths.resolve(data.path)
      : validateSystemPath(data.path);

    if (isAgentPath) {
      await ctx.paths.checkConditionalAccess(data.path);
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
