import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { confirm, select } from "@inquirer/prompts";
import { stringify } from "smol-toml";
import * as vb from "valibot";

import type { ConfigMigration, MigrationContext } from "#config/migrations/index.js";
import colors from "#output/colors.js";
import { info } from "#output/log.js";
import { root } from "#util/paths.js";

const MIGRATIONS_DIR = import.meta.dirname;
const STATE_FILE = path.join(root(), "config", "migrations.json");
const BACKUPS_DIR = path.join(root(), "config", "backups");

const MigrationStateSchema = vb.object({
  applied: vb.array(vb.string()),
});

type MigrationState = vb.InferOutput<typeof MigrationStateSchema>;

type MigrationMode = "cancel" | "run-all" | "step-through";

async function getMigrationState(): Promise<MigrationState> {
  if (!existsSync(STATE_FILE)) {
    return { applied: [] };
  }

  const data = await readFile(STATE_FILE, { encoding: "utf8" });
  try {
    const parsed = vb.parse(vb.partial(MigrationStateSchema), JSON.parse(data));
    return { applied: parsed.applied ?? [] };
  } catch {
    return { applied: [] };
  }
}

async function saveMigrationState(state: MigrationState): Promise<void> {
  const dir = path.join(STATE_FILE, "..");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(STATE_FILE, JSON.stringify({ applied: state.applied }, undefined, 2), {
    encoding: "utf8",
  });
}

function isMigrationImport(maybe: unknown): maybe is { migration: ConfigMigration } {
  if (maybe === null || typeof maybe !== "object" || !Object.hasOwn(maybe, "migration")) {
    return false;
  }

  return true;
}

async function loadMigrations(): Promise<ConfigMigration[]> {
  const migrations: ConfigMigration[] = [];

  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const migrationPath = path.join(MIGRATIONS_DIR, entry.name, "migration.ts");
    if (!existsSync(migrationPath)) {
      continue;
    }

    try {
      const imported: unknown = await import(migrationPath);

      if (!isMigrationImport(imported)) {
        throw new Error(
          `Migration at path ${colors.path(migrationPath)} is not a valid migration definition.`,
        );
      }

      migrations.push(imported.migration);
    } catch (error) {
      console.error(`Failed to load migration from ${entry.name}:`, error);
    }
  }

  migrations.sort((left, right) => left.id.localeCompare(right.id));

  return migrations;
}

async function promptForMode(pendingMigrations: ConfigMigration[]): Promise<MigrationMode> {
  info("");
  info(`There are ${colors.number(pendingMigrations.length)} pending migrations:`);
  info("");

  for (const migration of pendingMigrations) {
    info(`  ${colors.keyword("•")} ${colors.name(migration.id)}`);
    info(`    ${migration.description}`);
    info("");
  }

  const choices = [
    {
      description: "Apply all pending migrations automatically",
      name: "Run all migrations",
      value: "run-all" as MigrationMode,
    },
    {
      description: "Confirm each migration individually",
      name: "Step through migrations",
      value: "step-through" as MigrationMode,
    },
    {
      description: "Exit without applying migrations",
      name: "Cancel",
      value: "cancel" as MigrationMode,
    },
  ];

  const mode = await select({
    choices,
    message: "How would you like to proceed?",
  });

  return mode;
}

async function shouldApplyMigration(migration: ConfigMigration): Promise<boolean> {
  const answer = await confirm({
    default: true,
    message: `Apply migration ${colors.path(migration.id)}?`,
  });

  return answer;
}

function getBackupFilename(filePath: string): string {
  const filename = path.basename(filePath);

  if (filePath.includes("/agents/")) {
    const parts = filePath.split("/agents/");
    if (parts.length > 1 && parts[1] !== undefined) {
      const [slug, ...rest] = parts[1].split("/");
      // Include the relative path within the agent directory for uniqueness
      const relativePath = rest.join("_").replaceAll("/", "_");
      return `agents_${slug}_${relativePath}_${filename}`;
    }
  }

  return `global_${filename}`;
}

async function createBackup(migrationId: string, filePath: string, content: string): Promise<void> {
  const backupDir = path.join(BACKUPS_DIR, migrationId);
  if (!existsSync(backupDir)) {
    await mkdir(backupDir, { recursive: true });
  }

  const backupFilename = getBackupFilename(filePath);
  const backupPath = path.join(backupDir, backupFilename);
  await writeFile(backupPath, content, { encoding: "utf8" });
}

async function applyMigrationToFile(
  migration: ConfigMigration,
  configPath: string,
  context: MigrationContext,
  backedUpFiles: Set<string>,
): Promise<void> {
  if (!existsSync(configPath)) {
    return;
  }

  const originalData = await readFile(configPath, { encoding: "utf8" });

  if (!backedUpFiles.has(configPath)) {
    backedUpFiles.add(configPath);
    await createBackup(migration.id, configPath, originalData);
  }

  const { parse } = await import("smol-toml");
  const data = parse(originalData);

  const transformed = await migration.transform(data, context);

  const newData = stringify(transformed);
  await writeFile(configPath, newData, { encoding: "utf8" });
}

async function applyMigration(
  migration: ConfigMigration,
  agentSlugs: string[],
  mode: MigrationMode,
): Promise<boolean> {
  if (mode === "cancel") {
    return false;
  }

  if (mode === "step-through") {
    const shouldApply = await shouldApplyMigration(migration);
    if (!shouldApply) {
      info(`  Skipped migration ${colors.path(migration.id)}`);
      return false;
    }
  }

  info(`  Applying migration ${colors.path(migration.id)}...`);

  // Track backed up files to prevent overwriting original backups
  const backedUpFiles = new Set<string>();

  function createBackupHelper(): MigrationContext["backupFile"] {
    return async (filePath: string): Promise<void> => {
      if (!existsSync(filePath)) {
        return;
      }
      if (backedUpFiles.has(filePath)) {
        return;
      }
      backedUpFiles.add(filePath);
      const content = await readFile(filePath, { encoding: "utf8" });
      await createBackup(migration.id, filePath, content);
    };
  }

  const globalConfigFiles = ["integrations.toml", "plugins.toml", "engine.toml"] as const;
  for (const filename of globalConfigFiles) {
    if (migration.targets.includes(filename)) {
      const configPath = path.join(root(), "config", filename);
      const context: MigrationContext = {
        backupFile: createBackupHelper(),
        configPath,
        configType: "global",
      };
      await applyMigrationToFile(migration, configPath, context, backedUpFiles);
    }
  }

  for (const slug of agentSlugs) {
    for (const target of migration.targets) {
      let configPath: string | undefined = undefined;

      if (target === "channels/discord.toml") {
        configPath = path.join(root(), "agents", slug, "config", "channels", "discord.toml");
      } else if (target !== "integrations.toml" && target !== "plugins.toml") {
        configPath = path.join(root(), "agents", slug, "config", target);
      }

      if (configPath !== undefined) {
        const context: MigrationContext = {
          agentSlug: slug,
          backupFile: createBackupHelper(),
          configPath,
          configType: "agent",
        };
        await applyMigrationToFile(migration, configPath, context, backedUpFiles);
      }
    }
  }

  if (migration.migrateAgent !== undefined) {
    for (const slug of agentSlugs) {
      const agentPath = path.join(root(), "agents", slug);
      const context: MigrationContext = {
        agentSlug: slug,
        backupFile: createBackupHelper(),
        configPath: agentPath,
        configType: "agent",
      };
      await migration.migrateAgent(slug, agentPath, context);
    }
  }

  info(`  ${colors.success("✓")} Applied migration ${colors.path(migration.id)}`);
  return true;
}

export async function runMigrations(dryRun = false): Promise<number> {
  const state = await getMigrationState();
  const migrations = await loadMigrations();

  const appliedSet = new Set(state.applied);
  const pendingMigrations = migrations.filter((migration) => !appliedSet.has(migration.id));

  if (pendingMigrations.length === 0) {
    return 0;
  }

  const agentsDir = path.join(root(), "agents");
  let agentSlugs: string[] = [];

  if (existsSync(agentsDir)) {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    agentSlugs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  if (dryRun) {
    info("");
    info(
      `${colors.keyword("Dry run:")} ${colors.number(pendingMigrations.length)} pending migration(s) would be applied:`,
    );
    info("");

    for (const migration of pendingMigrations) {
      info(`  ${colors.name(migration.id)}`);
      info(`    ${colors.debug(migration.description)}`);

      const globalFiles = migration.targets.filter(
        (tgt) => tgt === "integrations.toml" || tgt === "plugins.toml" || tgt === "engine.toml",
      );
      const agentFiles = migration.targets.filter(
        (tgt) => tgt !== "integrations.toml" && tgt !== "plugins.toml",
      );

      if (globalFiles.length > 0) {
        info(`    ${colors.path("→ Global:")} ${globalFiles.join(", ")}`);
      }
      if (agentFiles.length > 0 && agentSlugs.length > 0) {
        info(`    ${colors.path("→ Agents:")} ${agentSlugs.join(", ")}`);
        info(`      Files: ${agentFiles.join(", ")}`);
      }
      info("");
    }

    return pendingMigrations.length;
  }

  const mode = await promptForMode(pendingMigrations);

  if (mode === "cancel") {
    info("  Migrations cancelled. Exiting.");
    throw new Error("Migrations cancelled by user");
  }

  const newlyApplied: string[] = [];

  for (const migration of pendingMigrations) {
    const applied = await applyMigration(migration, agentSlugs, mode);
    if (applied) {
      newlyApplied.push(migration.id);
    }
  }

  if (newlyApplied.length > 0) {
    state.applied.push(...newlyApplied);
    await saveMigrationState(state);
    info(`  ${colors.success("✓")} Applied ${colors.number(newlyApplied.length)} migration(s)`);
  }

  info("");

  return newlyApplied.length;
}
