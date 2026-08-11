import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse, stringify } from "smol-toml";
import type { TomlTable } from "smol-toml";

import type { ConfigMigration } from "#config/migrations/index.js";

function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function binaryList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return value;
}

const migration: ConfigMigration = {
  description: "Move Bubblewrap executable allowlists from tools.toml to sandbox.toml",
  id: "20260811000000_move_exec_binaries_to_bwrap",

  async migrateAgent(_agentSlug, agentPath, context): Promise<void> {
    const toolsPath = path.join(agentPath, "config", "tools.toml");
    if (!existsSync(toolsPath)) {
      return;
    }

    const tools = parse(await readFile(toolsPath, "utf8"));
    if (!isTable(tools["exec"])) {
      return;
    }
    const binaries = binaryList(tools["exec"]["binaries"]);
    if (binaries === undefined) {
      return;
    }

    const sandboxPath = path.join(agentPath, "config", "sandbox.toml");
    const sandbox = existsSync(sandboxPath)
      ? parse(await readFile(sandboxPath, "utf8"))
      : ({ mounts: [] } satisfies TomlTable);
    const { bwrap: configuredBwrap } = sandbox;
    const bwrap = isTable(configuredBwrap) ? configuredBwrap : {};
    if (!isTable(configuredBwrap)) {
      sandbox["bwrap"] = bwrap;
    }
    if (sandbox["backend"] === undefined || sandbox["backend"] === "bwrap") {
      bwrap["binaries"] = binaries;
    }

    delete tools["exec"]["binaries"];
    await context.backupFile(toolsPath);
    await writeFile(toolsPath, stringify(tools), "utf8");
    if (existsSync(sandboxPath)) {
      await context.backupFile(sandboxPath);
    }
    await writeFile(sandboxPath, stringify(sandbox), "utf8");
  },

  targets: [],

  transform(data) {
    return data;
  },
};

export { migration };
