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

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

const migration: ConfigMigration = {
  description: "Move Bubblewrap executable allowlists from tools.toml to sandbox.toml",
  id: "20260811000000_move_exec_binaries_to_bwrap",

  async migrateAgent(_agentSlug, agentPath, context): Promise<void> {
    const toolsPath = path.join(agentPath, "config", "tools.toml");
    const toolsContent = await readOptionalFile(toolsPath);
    if (toolsContent === undefined) {
      return;
    }

    const tools = parse(toolsContent);
    if (!isTable(tools["exec"])) {
      return;
    }
    const binaries = binaryList(tools["exec"]["binaries"]);
    if (binaries === undefined) {
      return;
    }

    const sandboxPath = path.join(agentPath, "config", "sandbox.toml");
    const sandboxContent = await readOptionalFile(sandboxPath);
    const sandbox =
      sandboxContent === undefined ? ({ mounts: [] } satisfies TomlTable) : parse(sandboxContent);
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
    await context.backupFile(sandboxPath);
    await writeFile(sandboxPath, stringify(sandbox), "utf8");
  },

  targets: [],

  transform(data) {
    return data;
  },
};

export { migration };
