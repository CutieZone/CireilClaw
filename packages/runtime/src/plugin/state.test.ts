import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PLUGIN_STATE_QUOTA_BYTES,
  pluginStateFolderSlug,
  readPluginStateFile,
  removePluginStateFile,
  resetVerifiedStateRoots,
  stateRoot,
  writePluginStateFile,
} from "./state.js";

let homeDir = "";

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "plugin-state-"));
  vi.stubEnv("HOME", homeDir);
  resetVerifiedStateRoots();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetVerifiedStateRoots();
  if (homeDir !== "") {
    await rm(homeDir, { force: true, recursive: true });
    homeDir = "";
  }
});

describe("pluginStateFolderSlug", () => {
  it("lowercases and replaces unsafe characters", () => {
    expect(pluginStateFolderSlug("MyPlugin")).toBe("myplugin");
  });

  it("sanitizes scoped npm package names", () => {
    expect(pluginStateFolderSlug("@cireilclaw/plugin-github")).toBe("cireilclaw-plugin-github");
  });

  it("collapses repeated separators", () => {
    expect(pluginStateFolderSlug("foo!!bar??baz")).toBe("foo-bar-baz");
  });

  it("falls back when result would be empty", () => {
    expect(pluginStateFolderSlug("")).toBe("plugin");
    expect(pluginStateFolderSlug("@@@")).toBe("plugin");
  });

  it("prefixes names starting with a dot", () => {
    expect(pluginStateFolderSlug(".hidden")).toBe("p-.hidden");
  });

  it("rejects non-string ids", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect(() => pluginStateFolderSlug(undefined as unknown as string)).toThrow("must be a string");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect(() => pluginStateFolderSlug(123 as unknown as string)).toThrow("must be a string");
  });
});

describe("stateRoot", () => {
  it("places the folder under ~/.cireilclaw/agents/<agent>/state/<pluginSlug>", () => {
    expect(stateRoot("bot", "github")).toBe(
      path.join(homeDir, ".cireilclaw", "agents", "bot", "state", "github"),
    );
  });

  it("sanitizes the plugin id segment", () => {
    expect(stateRoot("bot", "@cireilclaw/plugin-github")).toBe(
      path.join(homeDir, ".cireilclaw", "agents", "bot", "state", "cireilclaw-plugin-github"),
    );
  });
});

describe("readPluginStateFile", () => {
  it("returns undefined when the file does not exist", async () => {
    const value = await readPluginStateFile("bot", "github", "identity.json");
    expect(value).toBeUndefined();
  });

  it("returns the written content", async () => {
    await writePluginStateFile("bot", "github", "identity.json", "hello");
    const value = await readPluginStateFile("bot", "github", "identity.json");
    expect(value).toBe("hello");
  });

  it("supports nested paths", async () => {
    await writePluginStateFile("bot", "github", "dedupe/2026/08.json", '{"k":1}');
    expect(await readPluginStateFile("bot", "github", "dedupe/2026/08.json")).toBe('{"k":1}');
  });
});

describe("writePluginStateFile", () => {
  it("creates the state directory with mode 0o700", async () => {
    await writePluginStateFile("bot", "github", "x.txt", "y");
    const stats = statSync(path.join(homeDir, ".cireilclaw", "agents", "bot", "state", "github"));
    expect((stats.mode & 0o777).toString(8)).toBe("700");
  });

  it("creates parent directories with mode 0o700", async () => {
    await writePluginStateFile("bot", "github", "deep/nested/file.txt", "z");
    const nested = statSync(
      path.join(homeDir, ".cireilclaw", "agents", "bot", "state", "github", "deep", "nested"),
    );
    expect((nested.mode & 0o777).toString(8)).toBe("700");
  });

  it("writes the file with mode 0o600", async () => {
    await writePluginStateFile("bot", "github", "secret.txt", "topsecret");
    const stats = statSync(
      path.join(homeDir, ".cireilclaw", "agents", "bot", "state", "github", "secret.txt"),
    );
    expect((stats.mode & 0o777).toString(8)).toBe("600");
  });

  it("writes a .id sentinel owned by the plugin", async () => {
    await writePluginStateFile("bot", "github", "x.txt", "y");
    const sentinelPath = path.join(
      homeDir,
      ".cireilclaw",
      "agents",
      "bot",
      "state",
      "github",
      ".id",
    );
    expect(readFileSync(sentinelPath, "utf8")).toBe("github");
    const stats = statSync(sentinelPath);
    expect((stats.mode & 0o777).toString(8)).toBe("600");
  });

  it("leaves no temp file after writing", async () => {
    await writePluginStateFile("bot", "github", "x.txt", "y");
    const dir = path.join(homeDir, ".cireilclaw", "agents", "bot", "state", "github");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    const tmps = entries.filter((entry) => entry.startsWith(".tmp-"));
    expect(tmps).toEqual([]);
  });

  it("overwrites existing files atomically", async () => {
    await writePluginStateFile("bot", "github", "x.txt", "first");
    await writePluginStateFile("bot", "github", "x.txt", "second");
    expect(await readPluginStateFile("bot", "github", "x.txt")).toBe("second");
  });
});

describe("writePluginStateFile — rejections", () => {
  it("rejects absolute paths", async () => {
    await expect(writePluginStateFile("bot", "github", "/etc/passwd", "x")).rejects.toThrow(
      "must be relative",
    );
  });

  it("rejects path traversal", async () => {
    await expect(writePluginStateFile("bot", "github", "../escape.txt", "x")).rejects.toThrow(
      /traversal|escape/u,
    );
  });

  it("rejects the reserved .id name", async () => {
    await expect(writePluginStateFile("bot", "github", ".id", "x")).rejects.toThrow("reserved");
  });

  it("rejects an empty name", async () => {
    await expect(writePluginStateFile("bot", "github", "", "x")).rejects.toThrow("non-empty");
  });

  it("rejects when symlinked ancestor escapes the state root", async () => {
    // Pre-create a symlink inside the state root pointing outside.
    await writePluginStateFile("bot", "github", "probe.txt", "p");
    const outsideDir = path.join(homeDir, "outside");
    mkdirSync(outsideDir, { recursive: true });
    const stateRootDir = path.join(homeDir, ".cireilclaw", "agents", "bot", "state", "github");
    const linkPath = path.join(stateRootDir, "link-out");
    symlinkSync(outsideDir, linkPath);

    // Reading via the symlink should fail (lstat detects symlink on final path).
    await expect(readPluginStateFile("bot", "github", "link-out/file.txt")).rejects.toThrow(
      "symlink",
    );
  });

  it("rejects non-string content", async () => {
    await expect(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      writePluginStateFile("bot", "github", "x.txt", 123 as unknown as string),
    ).rejects.toThrow("must be a string");
  });
});

describe("writePluginStateFile — quota", () => {
  it("enforces a custom quota (4 bytes total)", async () => {
    await writePluginStateFile("bot", "github", "a.txt", "AAAA", 4);
    await expect(writePluginStateFile("bot", "github", "b.txt", "B", 4)).rejects.toThrow(
      "exceed the plugin quota",
    );
  });

  it("replaces existing files without counting them twice", async () => {
    await writePluginStateFile("bot", "github", "a.txt", "AAAA", 4);
    await writePluginStateFile("bot", "github", "a.txt", "BB", 4);
    expect(await readPluginStateFile("bot", "github", "a.txt")).toBe("BB");
  });

  it("excludes the .id sentinel from quota accounting", async () => {
    // Pre-create the state root with a valid sentinel, then grow a counted
    // file until it fills the quota. A subsequent write must fail; a write
    // that fits within (counted usage − existingSize + newSize) must succeed.
    await writePluginStateFile("bot", "github", "a.txt", "AAAA", 4);
    await expect(writePluginStateFile("bot", "github", "b.txt", "B", 4)).rejects.toThrow(
      "exceed the plugin quota",
    );
    // Remove the counted file and write a different one — should succeed
    // because the .id sentinel is not included in the usage sum.
    await removePluginStateFile("bot", "github", "a.txt");
    await expect(
      writePluginStateFile("bot", "github", "c.txt", "CCCC", 4),
    ).resolves.toBeUndefined();
  });

  it("defaults to 16 MiB when no quota is supplied", () => {
    expect(DEFAULT_PLUGIN_STATE_QUOTA_BYTES).toBe(16 * 1024 * 1024);
  });
});

describe("removePluginStateFile", () => {
  it("removes an existing file", async () => {
    await writePluginStateFile("bot", "github", "x.txt", "y");
    await removePluginStateFile("bot", "github", "x.txt");
    expect(await readPluginStateFile("bot", "github", "x.txt")).toBeUndefined();
  });

  it("is a no-op when the file is missing", async () => {
    await expect(removePluginStateFile("bot", "github", "nope.txt")).resolves.toBeUndefined();
  });

  it("rejects removing directories", async () => {
    await writePluginStateFile("bot", "github", "sub/a.txt", "y");
    await expect(removePluginStateFile("bot", "github", "sub")).rejects.toThrow("directory");
  });

  it("frees quota accounting", async () => {
    await writePluginStateFile("bot", "github", "a.txt", "AAAA", 4);
    await removePluginStateFile("bot", "github", "a.txt");
    await writePluginStateFile("bot", "github", "b.txt", "BBBB", 4);
    expect(await readPluginStateFile("bot", "github", "b.txt")).toBe("BBBB");
  });
});

describe("ensureStateRoot — collision detection", () => {
  it("throws when an existing .id belongs to a different plugin id", async () => {
    // Forge a state folder + sentinel for one plugin id, then attempt to
    // access it under a different plugin id by forging the same folder
    // slug. We simulate collision by writing the sentinel directly.
    const rootDir = path.join(homeDir, ".cireilclaw", "agents", "bot", "state", "github");
    mkdirSync(rootDir, { mode: 0o700, recursive: true });
    writeFileSync(path.join(rootDir, ".id"), "github", { mode: 0o600 });

    // Pre-seed a verified root so ensureStateRoot re-reads .id (skipping the
    // cache when we reset it).
    resetVerifiedStateRoots();
    await expect(
      readPluginStateFile("bot", "github", "does-not-exist.json"),
    ).resolves.toBeUndefined();

    // Forge the sentinel so it claims to belong to a *different* plugin id,
    // then reset cache and force re-verification.
    writeFileSync(path.join(rootDir, ".id"), "someone-else", { mode: 0o600 });
    resetVerifiedStateRoots();
    await expect(readPluginStateFile("bot", "github", "still-missing.json")).rejects.toThrow(
      "owned by another plugin id",
    );
  });

  it("verifies matching sentinel on second access", async () => {
    await writePluginStateFile("bot", "github", "x.txt", "y");
    resetVerifiedStateRoots();
    await expect(
      writePluginStateFile("bot", "github", "another.txt", "z"),
    ).resolves.toBeUndefined();
  });
});

describe("plugin id sanitization produces unique folders", () => {
  it("places distinct sanitized plugin ids under different folders", () => {
    const scoped = stateRoot("bot", "@cireilclaw/plugin-github");
    const plain = stateRoot("bot", "github");
    expect(scoped).not.toBe(plain);
  });

  it("uses realpath to resolve any symlink in the agent root on demand", async () => {
    // Pre-create the folder so we can observe what realpath returns.
    await writePluginStateFile("bot", "github", "x.txt", "y");
    const stateRootDir = path.join(homeDir, ".cireilclaw", "agents", "bot", "state", "github");
    expect(existsSync(realpathSync(stateRootDir))).toBe(true);
  });
});

describe("realpath on nonexistent final path", () => {
  it("write succeeds even though final path does not exist yet", async () => {
    await writePluginStateFile("bot", "github", "brand-new.txt", "v");
    expect(await readPluginStateFile("bot", "github", "brand-new.txt")).toBe("v");
  });
});
