import type { FileChangeInfo } from "node:fs/promises";
import type { TomlTable } from "smol-toml";

import color from "$/output/colors.js";
import merge from "fast-merge-async-iterators";
import { existsSync } from "node:fs";
import { readdir, readFile, watch } from "node:fs/promises";
import path from "node:path";
import { env } from "node:process";
import { parse } from "smol-toml";
import * as vb from "valibot";

const EngineConfigSchema = vb.strictObject({
  apiBase: vb.pipe(vb.string(), vb.nonEmpty(), vb.url()),
  apiKey: vb.exactOptional(vb.pipe(vb.string(), vb.nonEmpty()), "not-needed"),
  model: vb.pipe(vb.string(), vb.nonEmpty()),
});

type EngineConfig = vb.InferOutput<typeof EngineConfigSchema>;

function root(): string {
  const home = env.HOME;

  if (home === undefined) {
    throw new Error("$HOME variable not available");
  }

  return path.join(home, ".cireilclaw");
}

/**
 * Load and parses the appropriate engine config.
 * @param agentSlug Optional slug to specify the agent for which to load the engine config for
 */
async function loadEngine(agentSlug?: string): Promise<EngineConfig> {
  let obj: TomlTable | undefined = undefined;
  if (agentSlug === undefined) {
    const file = path.join(root(), "config", "engine.toml");

    if (existsSync(file)) {
      const data = await readFile(file, { encoding: "utf8" });

      obj = parse(data);
    } else {
      throw new Error(`Could not find config file at path: ${color.path(file)}`);
    }
  } else {
    const file = path.join(root(), "agents", agentSlug, "config", "engine.toml");

    if (existsSync(file)) {
      const data = await readFile(file, { encoding: "utf8" });

      obj = parse(data);
    } else {
      throw new Error(`Could not find config file at path: ${color.path(file)}`);
    }
  }

  const cfg = vb.parse(EngineConfigSchema, obj);

  return cfg;
}

type Watchers = AsyncIterableIterator<FileChangeInfo<string>>;
async function watcher(signal: AbortSignal): Promise<Watchers> {
  const globalConfigWatcher = watch(path.join(root(), "config"), {
    encoding: "utf8",
    recursive: true,
    signal: signal,
  });

  if (!existsSync(path.join(root(), "agents"))) {
    return globalConfigWatcher;
  }

  const agentsFiles = await readdir(path.join(root(), "agents"), {
    encoding: "utf8",
    withFileTypes: true,
  });

  const agentsWatchers = agentsFiles
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("/config"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .map((entry) =>
      watch(entry, {
        encoding: "utf8",
        recursive: true,
        signal: signal,
      }),
    );

  return merge.default("iters-close-wait", globalConfigWatcher, ...agentsWatchers);
}

export { EngineConfigSchema, loadEngine, watcher };
export type { EngineConfig, Watchers };
