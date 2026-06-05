import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
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

  if (!path.isAbsolute(home)) {
    throw new Error("$HOME is not an absolute path");
  }

  const realHome = realpathSync(home);
  return path.join(realHome, ".cireilclaw");
}

function agentRoot(agentSlug: string): string {
  return path.join(root(), "agents", agentSlug);
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

function sandboxToReal(pth: string, agentSlug: string, mounts?: readonly Mount[]): string {
  const resolved =
    mounts !== undefined && mounts.length > 0 ? resolveMount(pth, mounts) : undefined;

  if (resolved !== undefined) {
    const { mount, innerPath } = resolved;
    const realPath = path.normalize(path.join(mount.source, innerPath));
    const relativeToSource = path.relative(mount.source, realPath);

    if (relativeToSource.startsWith("..") || path.isAbsolute(relativeToSource)) {
      throw new Error(`Access denied: path '${pth}' attempts to escape the mount boundary.`);
    }

    const segments: string[] = [];
    let current = realPath;

    while (!existsSync(current)) {
      segments.unshift(path.basename(current));
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Access denied: no resolvable ancestor for '${pth}'`);
      }
      current = parent;
    }

    const resolvedBase = realpathSync(current);
    const fullResolved = path.join(resolvedBase, ...segments);
    const realRelative = path.relative(mount.source, fullResolved);

    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new Error(`Access denied: path '${pth}' resolves outside the mount via symlink.`);
    }

    return fullResolved;
  }

  const origin = agentRoot(agentSlug);

  let sandboxPath = "";
  let expectedSubdir: "blocks" | "memories" | "skills" | "tasks" | "workspace" | undefined =
    undefined;

  if (pth === "/blocks" || pth.startsWith("/blocks/")) {
    expectedSubdir = "blocks";
    sandboxPath = path.join(origin, "blocks", pth.slice("/blocks".length));
  } else if (pth === "/memories" || pth.startsWith("/memories/")) {
    expectedSubdir = "memories";
    sandboxPath = path.join(origin, "memories", pth.slice("/memories".length));
  } else if (pth === "/skills" || pth.startsWith("/skills/")) {
    expectedSubdir = "skills";
    sandboxPath = path.join(origin, "skills", pth.slice("/skills".length));
  } else if (pth === "/tasks" || pth.startsWith("/tasks/")) {
    expectedSubdir = "tasks";
    sandboxPath = path.join(origin, "tasks", pth.slice("/tasks".length));
  } else if (pth === "/workspace" || pth.startsWith("/workspace/")) {
    expectedSubdir = "workspace";
    sandboxPath = path.join(origin, "workspace", pth.slice("/workspace".length));
  } else {
    throw new Error(`Access denied: path '${pth}' is outside the sandbox.`);
  }

  const normalizedPath = path.normalize(sandboxPath);
  const relativePath = path.relative(origin, normalizedPath);

  if (relativePath.startsWith("..")) {
    throw new Error(`Access denied: path '${pth}' attempts to escape the sandbox.`);
  }

  if (!relativePath.startsWith(`${expectedSubdir}/`) && relativePath !== expectedSubdir) {
    throw new Error(`Access denied: path '${pth}' escaped the ${expectedSubdir} sandbox area.`);
  }

  const segments: string[] = [];
  let current = normalizedPath;

  while (!existsSync(current)) {
    segments.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Access denied: no resolvable ancestor for '${pth}'`);
    }
    current = parent;
  }

  const resolvedBase = realpathSync(current);
  const fullResolved = path.join(resolvedBase, ...segments);
  const realOrigin = realpathSync(origin);
  const realRelative = path.relative(realOrigin, fullResolved);

  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`Access denied: path '${pth}' resolves outside the sandbox via symlink.`);
  }

  if (!realRelative.startsWith(`${expectedSubdir}/`) && realRelative !== expectedSubdir) {
    throw new Error(
      `Access denied: path '${pth}' escaped the ${expectedSubdir} sandbox area via symlink.`,
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

  const rest =
    sandboxPath === "/workspace" || sandboxPath === "/workspace/"
      ? ""
      : sandboxPath.slice("/workspace/".length);

  for (const mount of mounts) {
    if (rest === mount.target || rest.startsWith(`${mount.target}/`)) {
      return [];
    }
  }

  const entries = new Map<string, { name: string; type: "directory" }>();

  for (const mount of mounts) {
    if (rest === "") {
      const [firstSegment] = mount.target.split("/");
      if (firstSegment !== undefined) {
        entries.set(firstSegment, { name: firstSegment, type: "directory" });
      }
    } else if (mount.target.startsWith(`${rest}/`)) {
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

function checkConditionalAccess(
  sandboxPath: string,
  _agentSlug: string,
  conditions: ConditionsConfig,
  session: Session,
): void {
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
    return;
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

// /bin is intentionally excluded — it is a synthetic sandbox dir, not a real host path.
const EXEC_VISIBLE_PREFIXES = ["/usr", "/lib", "/lib64", "/nix"] as const;

function validateSystemPath(pth: string): string {
  if (pth.includes("..")) {
    throw new Error(`Access denied: path '${pth}' contains path traversal.`);
  }

  const normalized = path.normalize(pth);
  const isAllowed = EXEC_VISIBLE_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );

  if (!isAllowed) {
    throw new Error(`Access denied: path '${pth}' is outside the sandbox.`);
  }

  if (!existsSync(normalized)) {
    return normalized;
  }

  const resolved = realpathSync(normalized);
  const isResolvedAllowed = EXEC_VISIBLE_PREFIXES.some(
    (prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`),
  );

  if (!isResolvedAllowed) {
    throw new Error(`Access denied: path '${pth}' resolves outside the sandbox via symlink.`);
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
