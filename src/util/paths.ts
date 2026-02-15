import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { env } from "node:process";

function root(): string {
  const home = env.HOME;

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
  let expectedSubdir: "blocks" | "memories" | "skills" | "workspace" | undefined = undefined;

  if (path.startsWith("/blocks/")) {
    expectedSubdir = "blocks";
    sandboxPath = join(origin, "blocks", path.slice("/blocks/".length));
  } else if (path.startsWith("/memories/")) {
    expectedSubdir = "memories";
    sandboxPath = join(origin, "memories", path.slice("/memories/".length));
  } else if (path.startsWith("/skills/")) {
    expectedSubdir = "skills";
    sandboxPath = join(origin, "skills", path.slice("/skills/".length));
  } else if (path.startsWith("/workspace/")) {
    expectedSubdir = "workspace";
    sandboxPath = join(origin, "workspace", path.slice("/workspace/".length));
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

export { sandboxToReal, sanitizeError, agentRoot, root };
