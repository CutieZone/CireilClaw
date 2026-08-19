import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { agentRoot } from "#util/paths.js";

const DEFAULT_PLUGIN_STATE_QUOTA_BYTES = 16 * 1024 * 1024;

const STATE_SENTINEL = ".id";

const verifiedRoots = new Set<string>();
const stateLocks = new Map<string, Promise<void>>();

function errnoCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error) {
    const { code } = error as { code: unknown };
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
}

function pluginStateFolderSlug(pluginId: string): string {
  if (typeof pluginId !== "string") {
    throw new TypeError("pluginState: pluginId must be a string");
  }
  const replaced = pluginId
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, "-")
    .replaceAll(/-{2,}/gu, "-")
    .replaceAll(/(^-+)|(-+$)/gu, "");
  let slug = replaced.length > 0 ? replaced : "plugin";
  if (slug.startsWith(".")) {
    slug = `p-${slug}`;
  }
  if (slug === "." || slug === "..") {
    slug = "p-plugin";
  }
  return slug;
}

function stateRoot(agentSlug: string, pluginId: string): string {
  return path.join(agentRoot(agentSlug), "state", pluginStateFolderSlug(pluginId));
}

function verifySentinel(sentinelPath: string, realRoot: string, pluginId: string): void {
  let existing: string | undefined = undefined;
  try {
    existing = readFileSync(sentinelPath, "utf8");
  } catch {
    throw new Error(`pluginState: ${STATE_SENTINEL} sentinel at ${realRoot} is unreadable`);
  }
  if (existing !== pluginId) {
    throw new Error(
      `pluginState: state folder at ${realRoot} is owned by another plugin id ` +
        `(existing: '${existing}', requested: '${pluginId}')`,
    );
  }
}

async function ensureStateRoot(agentSlug: string, pluginId: string): Promise<string> {
  const stateDir = path.join(agentRoot(agentSlug), "state");
  await mkdir(stateDir, { mode: 0o700, recursive: true });
  await chmod(stateDir, 0o700);
  const stateDirStats = await lstat(stateDir);
  if (stateDirStats.isSymbolicLink()) {
    throw new Error(`pluginState: state directory is a symlink: ${stateDir}`);
  }

  const root = stateRoot(agentSlug, pluginId);
  const rootStats = existsSync(root) ? await lstat(root) : undefined;
  if (rootStats?.isSymbolicLink() === true) {
    throw new Error(`pluginState: state folder is a symlink: ${root}`);
  }
  await mkdir(root, { mode: 0o700, recursive: true });
  await chmod(root, 0o700);
  const realRoot = realpathSync(root);
  const realStateDir = realpathSync(stateDir);
  const relativeToState = path.relative(realStateDir, realRoot);
  if (relativeToState.startsWith("..") || path.isAbsolute(relativeToState)) {
    throw new Error(`pluginState: state folder resolves outside the agent state directory`);
  }
  const sentinelPath = path.join(realRoot, STATE_SENTINEL);
  if (verifiedRoots.has(realRoot)) {
    return realRoot;
  }
  if (existsSync(sentinelPath)) {
    verifySentinel(sentinelPath, realRoot, pluginId);
  } else {
    try {
      const handle = openSync(sentinelPath, "wx", 0o600);
      try {
        writeFileSync(handle, pluginId, "utf8");
      } finally {
        closeSync(handle);
      }
    } catch (error: unknown) {
      if (errnoCode(error) !== "EEXIST") {
        throw error;
      }
      verifySentinel(sentinelPath, realRoot, pluginId);
    }
  }
  verifiedRoots.add(realRoot);
  return realRoot;
}

async function withStateLock<Result>(
  stateRootPath: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = stateLocks.get(stateRootPath) ?? Promise.resolve();
  const release = {
    resolve(): void {
      // The executor replaces this before the lock can be released.
    },
  };
  function setRelease(resolveLock: (value: void | PromiseLike<void>) => void): void {
    function releaseLock(): void {
      resolveLock();
    }
    release.resolve = releaseLock;
  }
  const current = new Promise<void>(setRelease);
  stateLocks.set(stateRootPath, current);

  await previous;
  try {
    return await operation();
  } finally {
    release.resolve();
    if (stateLocks.get(stateRootPath) === current) {
      stateLocks.delete(stateRootPath);
    }
  }
}

function resetVerifiedStateRoots(): void {
  verifiedRoots.clear();
  stateLocks.clear();
}

function validateRelativeName(name: string): string[] {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("pluginState: 'name' must be a non-empty string");
  }
  if (path.isAbsolute(name)) {
    throw new Error(`pluginState: 'name' must be relative, got '${name}'`);
  }
  const segments = name.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error(`pluginState: 'name' contains empty segments: '${name}'`);
  }
  if (segments.includes("..")) {
    throw new Error(`pluginState: 'name' contains path traversal: '${name}'`);
  }
  const [first] = segments;
  if (first === undefined || first === STATE_SENTINEL) {
    throw new Error(`pluginState: '${STATE_SENTINEL}' is reserved as a runtime sentinel`);
  }
  return segments;
}

async function resolveStatePath(rootDir: string, name: string): Promise<string> {
  const segments = validateRelativeName(name);
  const target = path.join(rootDir, ...segments);
  const normalized = path.normalize(target);
  const relativeToRoot = path.relative(rootDir, normalized);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error(`pluginState: 'name' escapes the state directory: '${name}'`);
  }
  if (existsSync(normalized)) {
    const stats = await lstat(normalized);
    if (stats.isSymbolicLink()) {
      throw new Error(`pluginState: 'name' resolves to a symlink: '${name}'`);
    }
  }
  const walkSegments: string[] = [];
  let current = normalized;
  while (!existsSync(current)) {
    walkSegments.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`pluginState: no resolvable ancestor for '${name}'`);
    }
    current = parent;
  }
  const ancestorLstats = await lstat(current);
  if (ancestorLstats.isSymbolicLink()) {
    throw new Error(`pluginState: 'name' traverses a symlinked ancestor: '${name}'`);
  }
  const resolvedBase = realpathSync(current);
  const fullResolved = path.join(resolvedBase, ...walkSegments);
  const realRoot = realpathSync(rootDir);
  const realRelative = path.relative(realRoot, fullResolved);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`pluginState: 'name' resolves outside the state directory via symlink`);
  }
  return fullResolved;
}

async function directoryByteUsage(rootDir: string): Promise<number> {
  let total = 0;
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    const entries = await readdir(current, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        continue;
      }
      if (entry.name === STATE_SENTINEL) {
        continue;
      }
      const stats = await stat(entryPath);
      total += stats.size;
    }
  }
  return total;
}

async function readPluginStateFile(
  agentSlug: string,
  pluginId: string,
  name: string,
): Promise<string | undefined> {
  const root = await ensureStateRoot(agentSlug, pluginId);
  const target = await resolveStatePath(root, name);
  try {
    return await readFile(target, "utf8");
  } catch (error: unknown) {
    if (errnoCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writePluginStateFile(
  agentSlug: string,
  pluginId: string,
  name: string,
  content: string,
  quotaBytes: number = DEFAULT_PLUGIN_STATE_QUOTA_BYTES,
): Promise<void> {
  if (typeof content !== "string") {
    throw new TypeError("pluginState: 'content' must be a string");
  }
  const root = await ensureStateRoot(agentSlug, pluginId);
  await withStateLock(root, async () => {
    const target = await resolveStatePath(root, name);
    const segments = validateRelativeName(name);
    const parentDir = path.dirname(target);
    if (!existsSync(parentDir)) {
      await mkdir(parentDir, { mode: 0o700, recursive: true });
      await chmod(parentDir, 0o700);
    }
    const existingSize = existsSync(target) ? statSync(target).size : 0;
    const usage = await directoryByteUsage(root);
    const projected = usage - existingSize + Buffer.byteLength(content, "utf8");
    if (projected > quotaBytes) {
      throw new Error(
        `pluginState: writing '${name}' would exceed the plugin quota ` +
          `(${projected} > ${quotaBytes} bytes)`,
      );
    }
    const baseName = segments.at(-1) ?? "state";
    const tempName = `.tmp-${baseName}-${randomBytes(8).toString("hex")}`;
    const tempPath = path.join(parentDir, tempName);
    const handle = openSync(tempPath, "wx", 0o600);
    try {
      writeFileSync(handle, content, "utf8");
    } finally {
      closeSync(handle);
    }
    await rename(tempPath, target);
  });
}

async function removePluginStateFile(
  agentSlug: string,
  pluginId: string,
  name: string,
): Promise<void> {
  const root = await ensureStateRoot(agentSlug, pluginId);
  await withStateLock(root, async () => {
    const target = await resolveStatePath(root, name);
    // oxlint-disable-next-line eslint/init-declarations -- assigned in try, ENOENT returns early
    let stats: Stats;
    try {
      stats = await lstat(target);
    } catch (error: unknown) {
      if (errnoCode(error) === "ENOENT") {
        return;
      }
      throw error;
    }
    if (stats.isDirectory()) {
      throw new Error(
        `pluginState: refusing to remove directory via pluginState.remove: '${name}'`,
      );
    }
    await rm(target, { force: true });
  });
}

export {
  DEFAULT_PLUGIN_STATE_QUOTA_BYTES,
  pluginStateFolderSlug,
  readPluginStateFile,
  removePluginStateFile,
  resetVerifiedStateRoots,
  stateRoot,
  writePluginStateFile,
};
