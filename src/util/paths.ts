import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { env } from "node:process";

import type { ConditionsConfig, PathRule } from "$/config/conditions.js";
import type { Session } from "$/harness/session.js";
import { checkPathAccess } from "$/util/conditions.js";

function root(): string {
  const home = env["HOME"];

  if (home === undefined) {
    throw new Error("$HOME variable not available");
  }

  return join(home, ".cireilclaw");
}

function agentRoot(agentSlug: string): string {
  return join(root(), "agents", agentSlug);
}

function sandboxToReal(path: string, agentSlug: string): string {
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

function sanitizeError(err: unknown, agentSlug: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replaceAll(agentRoot(agentSlug), "<sandbox>");
}

/**
 * Check conditional access for a path after baseline sandbox validation.
 * Throws an error if access is denied by conditional rules.
 *
 * @param sandboxPath The sandbox path to check
 * @param _agentSlug The agent slug (unused but kept for API consistency)
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

  if (sandboxPath === "/memories" || sandboxPath.startsWith("/memories/")) {
    rules = conditions.memories;
  } else if (sandboxPath === "/workspace" || sandboxPath.startsWith("/workspace/")) {
    rules = conditions.workspace;
  }

  if (rules === undefined) {
    return; // No conditional rules for this path
  }

  if (!checkPathAccess(sandboxPath, rules, session)) {
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

  const isAllowed = EXEC_VISIBLE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );

  if (!isAllowed) {
    throw new Error(`Access denied: path '${path}' is outside the sandbox.`);
  }

  return normalize(path);
}

export {
  sandboxToReal,
  sanitizeError,
  agentRoot,
  root,
  checkConditionalAccess,
  validateSystemPath,
};
