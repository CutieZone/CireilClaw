import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { env } from "node:process";

import type { ConditionsConfig, PathRule } from "#config/schemas/conditions.js";
import type { Mount } from "#config/schemas/sandbox.js";
import type { Session } from "#harness/session.js";
import { checkPathAccess } from "#util/conditions.js";

function root(): string {
  const home = env["HOME"];

  if (home === undefined) {
    throw new Error("$HOME variable not available");
  }

  if (!isAbsolute(home)) {
    throw new Error("$HOME is not an absolute path");
  }

  const realHome = realpathSync(home);
  return join(realHome, ".cireilclaw");
}

function agentRoot(agentSlug: string): string {
  return join(root(), "agents", agentSlug);
}

function resolveMount(
  sandboxPath: string,
  mounts: readonly Mount[],
): { mount: Mount; innerPath: string } | undefined {
  if (!sandboxPath.startsWith("/workspace/")) {
    return undefined;
  }

  const rest = sandboxPath.slice("/workspace/".length);

  for (const mount of mounts) {
    if (rest === mount.target) {
      return { innerPath: "", mount };
    }
    if (rest.startsWith(`${mount.target}/`)) {
      return { innerPath: rest.slice(mount.target.length), mount };
    }
  }

  return undefined;
}

function sandboxToReal(path: string, agentSlug: string, mounts?: readonly Mount[]): string {
  const resolved =
    mounts !== undefined && mounts.length > 0 ? resolveMount(path, mounts) : undefined;

  if (resolved !== undefined) {
    const { mount, innerPath } = resolved;
    const realPath = normalize(join(mount.source, innerPath));
    const relativeToSource = relative(mount.source, realPath);

    if (relativeToSource.startsWith("..") || isAbsolute(relativeToSource)) {
      throw new Error(`Access denied: path '${path}' attempts to escape the mount boundary.`);
    }

    const segments: string[] = [];
    let current = realPath;

    while (!existsSync(current)) {
      segments.unshift(basename(current));
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(`Access denied: no resolvable ancestor for '${path}'`);
      }
      current = parent;
    }

    const resolvedBase = realpathSync(current);
    const fullResolved = join(resolvedBase, ...segments);
    const realRelative = relative(mount.source, fullResolved);

    if (realRelative.startsWith("..") || isAbsolute(realRelative)) {
      throw new Error(`Access denied: path '${path}' resolves outside the mount via symlink.`);
    }

    return fullResolved;
  }

  const origin = agentRoot(agentSlug);

  let sandboxPath = "";
  let expectedSubdir: "blocks" | "memories" | "skills" | "tasks" | "workspace" | undefined =
    undefined;

  if (path === "/blocks" || path.startsWith("/blocks/")) {
    expectedSubdir = "blocks";
    sandboxPath = join(origin, "blocks", path.slice("/blocks".length));
  } else if (path === "/memories" || path.startsWith("/memories/")) {
    expectedSubdir = "memories";
    sandboxPath = join(origin, "memories", path.slice("/memories".length));
  } else if (path === "/skills" || path.startsWith("/skills/")) {
    expectedSubdir = "skills";
    sandboxPath = join(origin, "skills", path.slice("/skills".length));
  } else if (path === "/tasks" || path.startsWith("/tasks/")) {
    expectedSubdir = "tasks";
    sandboxPath = join(origin, "tasks", path.slice("/tasks".length));
  } else if (path === "/workspace" || path.startsWith("/workspace/")) {
    expectedSubdir = "workspace";
    sandboxPath = join(origin, "workspace", path.slice("/workspace".length));
  } else {
    throw new Error(`Access denied: path '${path}' is outside the sandbox.`);
  }

  const normalizedPath = normalize(sandboxPath);
  const relativePath = relative(origin, normalizedPath);

  if (relativePath.startsWith("..")) {
    throw new Error(`Access denied: path '${path}' attempts to escape the sandbox.`);
  }

  if (!relativePath.startsWith(`${expectedSubdir}/`) && relativePath !== expectedSubdir) {
    throw new Error(`Access denied: path '${path}' escaped the ${expectedSubdir} sandbox area.`);
  }

  // Resolve symlinks on the existing portion of the path,
  // then reattach any not-yet-created tail segments.
  const segments: string[] = [];
  let current = normalizedPath;

  while (!existsSync(current)) {
    segments.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Access denied: no resolvable ancestor for '${path}'`);
    }
    current = parent;
  }

  const resolvedBase = realpathSync(current);
  const fullResolved = join(resolvedBase, ...segments);
  const realOrigin = realpathSync(origin);
  const realRelative = relative(realOrigin, fullResolved);

  if (realRelative.startsWith("..") || isAbsolute(realRelative)) {
    throw new Error(`Access denied: path '${path}' resolves outside the sandbox via symlink.`);
  }

  if (!realRelative.startsWith(`${expectedSubdir}/`) && realRelative !== expectedSubdir) {
    throw new Error(
      `Access denied: path '${path}' escaped the ${expectedSubdir} sandbox area via symlink.`,
    );
  }

  return fullResolved;
}

function checkMountWriteAccess(sandboxPath: string, mounts: readonly Mount[]): void {
  const resolved = resolveMount(sandboxPath, mounts);
  if (resolved?.mount.mode === "ro") {
    throw new Error(
      `Access denied: path '${sandboxPath}' is on a read-only mount (${resolved.mount.target}).`,
    );
  }
}

function getMountEntriesAtPath(
  sandboxPath: string,
  mounts: readonly Mount[],
): { name: string; type: "directory" }[] {
  if (sandboxPath !== "/workspace" && !sandboxPath.startsWith("/workspace/")) {
    return [];
  }

  const rest = sandboxPath === "/workspace" ? "" : sandboxPath.slice("/workspace/".length);

  // If we're inside or exactly at a mount target, readdir on the resolved real path handles it.
  for (const mount of mounts) {
    if (rest === mount.target || rest.startsWith(`${mount.target}/`)) {
      return [];
    }
  }

  const entries = new Map<string, { name: string; type: "directory" }>();

  for (const mount of mounts) {
    if (rest === "") {
      // At /workspace — first segment of each mount target is visible.
      const [firstSegment] = mount.target.split("/");
      if (firstSegment !== undefined) {
        entries.set(firstSegment, { name: firstSegment, type: "directory" });
      }
    } else if (mount.target.startsWith(`${rest}/`)) {
      // At a subdirectory that is a prefix of a mount target.
      const remaining = mount.target.slice(rest.length + 1);
      const [firstSegment] = remaining.split("/");
      if (firstSegment !== undefined) {
        entries.set(firstSegment, { name: firstSegment, type: "directory" });
      }
    }
  }

  return [...entries.values()];
}

function sanitizeError(err: unknown, agentSlug: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replaceAll(agentRoot(agentSlug), "<sandbox>");
}

/**
 * Check conditional access for a path after baseline sandbox validation.
 * Throws an error if access is denied by conditional rules.
 *
 * @param sandboxPath The sandbox path to check
 * @param agentSlug The agent slug
 * @param conditions The conditions config
 * @param session The current session
 * @throws Error if access is denied
 */
function checkConditionalAccess(
  sandboxPath: string,
  _agentSlug: string,
  conditions: ConditionsConfig,
  session: Session,
): void {
  // Determine which ruleset to apply based on the path prefix
  let rules: Record<string, PathRule> | undefined = undefined;
  let relativePath = sandboxPath;

  if (sandboxPath === "/memories" || sandboxPath.startsWith("/memories/")) {
    rules = conditions.memories;
    relativePath = sandboxPath === "/memories" ? "/" : sandboxPath.slice("/memories".length);
  } else if (sandboxPath === "/workspace" || sandboxPath.startsWith("/workspace/")) {
    rules = conditions.workspace;
    relativePath = sandboxPath === "/workspace" ? "/" : sandboxPath.slice("/workspace".length);
  }

  if (rules === undefined) {
    return; // No conditional rules for this path
  }

  if (!checkPathAccess(relativePath, rules, session)) {
    const guildInfo =
      session.channel === "discord" && session.guildId !== undefined
        ? `, guild: ${session.guildId}`
        : "";
    const nsfwInfo = session.channel === "discord" ? `, nsfw: ${session.isNsfw}` : "";
    throw new Error(
      `Access denied: path '${sandboxPath}' is not accessible in the current context (channel: ${session.channel}${guildInfo}${nsfwInfo})`,
    );
  }
}

// Paths that are bound read-only into the exec sandbox (mirrors sandbox.ts bindings).
// /bin is intentionally excluded — it is a synthetic sandbox dir, not a real host path.
const EXEC_VISIBLE_PREFIXES = ["/usr", "/lib", "/lib64", "/nix"] as const;

/**
 * Validates a system path that is accessible in the exec sandbox.
 * These paths are bound read-only from the host filesystem.
 * Returns the normalized real path, or throws if the path is not allowed.
 */
function validateSystemPath(path: string): string {
  if (path.includes("..")) {
    throw new Error(`Access denied: path '${path}' contains path traversal.`);
  }

  const normalized = normalize(path);
  const isAllowed = EXEC_VISIBLE_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );

  if (!isAllowed) {
    throw new Error(`Access denied: path '${path}' is outside the sandbox.`);
  }

  if (!existsSync(normalized)) {
    return normalized;
  }

  const resolved = realpathSync(normalized);
  const isResolvedAllowed = EXEC_VISIBLE_PREFIXES.some(
    (prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`),
  );

  if (!isResolvedAllowed) {
    throw new Error(`Access denied: path '${path}' resolves outside the sandbox via symlink.`);
  }

  return resolved;
}

export {
  checkMountWriteAccess,
  getMountEntriesAtPath,
  sandboxToReal,
  sanitizeError,
  agentRoot,
  root,
  checkConditionalAccess,
  validateSystemPath,
};
