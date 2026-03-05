import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

import type { ConfigMigration, MigrationContext } from "$/config/migrations/index.js";
import colors from "$/output/colors.js";
import { info } from "$/output/log.js";
import { root } from "$/util/paths.js";
import { confirm, select } from "@inquirer/prompts";
import { stringify } from "smol-toml";

const MIGRATIONS_DIR = fileURLToPath(new URL("./", import.meta.url));
const STATE_FILE = join(root(), "config", "migrations.json");
const BACKUPS_DIR = join(root(), "config", "backups");

interface MigrationState {
  applied: string[];
}

type MigrationMode = "cancel" | "run-all" | "step-through";

async function getMigrationState(): Promise<MigrationState> {
  if (!existsSync(STATE_FILE)) {
    return { applied: [] };
  }

  const data = await readFile(STATE_FILE, { encoding: "utf8" });
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const parsed = JSON.parse(data) as { applied?: string[] };
    return { applied: parsed.applied ?? [] };
  } catch {
    return { applied: [] };
  }
}

async function saveMigrationState(state: MigrationState): Promise<void> {
  const dir = join(STATE_FILE, "..");
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

  // Read all subdirectories in migrations directory
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const migrationPath = join(MIGRATIONS_DIR, entry.name, "migration.ts");
    if (!existsSync(migrationPath)) {
      continue;
    }

    try {
      // Dynamic import of the migration module
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

  // Sort by ID (timestamp prefix)
  migrations.sort((left, right) => left.id.localeCompare(right.id));

  return migrations;
}

async function promptForMode(pendingMigrations: ConfigMigration[]): Promise<MigrationMode> {
  info("");
  info(`${colors.keyword("cireilclaw")} Pending configuration migrations:`);
  info("");

  for (const migration of pendingMigrations) {
    info(`  ${colors.keyword("•")} ${colors.path(migration.id)}`);
    info(`    ${migration.description}`);
    info("");
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const choices = [
    {
      description: "Apply all pending migrations automatically",
      name: "Run all migrations",
      value: "run-all",
    },
    {
      description: "Confirm each migration individually",
      name: "Step through migrations",
      value: "step-through",
    },
    {
      description: "Exit without applying migrations",
      name: "Cancel",
      value: "cancel",
    },
  ];

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-type-assertion
  const mode = (await select({
    choices,
    message: "How would you like to proceed?",
  })) as MigrationMode;

  return mode;
}

async function shouldApplyMigration(migration: ConfigMigration): Promise<boolean> {
  const answer = await confirm({
    default: true,
    message: `Apply migration ${colors.path(migration.id)}?`,
  });

  return answer;
}

async function createBackup(
  migrationId: string,
  configPath: string,
  originalData: string,
): Promise<void> {
  const backupDir = join(BACKUPS_DIR, migrationId);
  if (!existsSync(backupDir)) {
    await mkdir(backupDir, { recursive: true });
  }

  // Create a unique backup filename based on the config path
  // For agent configs, use "agents_{slug}_config_{filename}"
  // For global configs, use "global_config_{filename}"
  const filename = basename(configPath);
  let backupFilename = `global_config_${filename}`;

  if (configPath.includes("/agents/")) {
    // Extract agent slug from path
    const parts = configPath.split("/agents/");
    if (parts.length > 1 && parts[1] !== undefined) {
      const [slug] = parts[1].split("/");
      backupFilename = `agents_${slug}_config_${filename}`;
    }
  }

  const backupPath = join(backupDir, backupFilename);
  await writeFile(backupPath, originalData, { encoding: "utf8" });
}

async function applyMigrationToFile(
  migration: ConfigMigration,
  configPath: string,
  context: MigrationContext,
): Promise<void> {
  if (!existsSync(configPath)) {
    return;
  }

  const originalData = await readFile(configPath, { encoding: "utf8" });

  // Create backup before modifying
  await createBackup(migration.id, configPath, originalData);

  // Parse TOML
  const { parse } = await import("smol-toml");
  const data = parse(originalData);

  // Apply migration transformation
  const transformed = await migration.transform(data, context);

  // Write back to file
  const newData = stringify(transformed);
  await writeFile(configPath, newData, { encoding: "utf8" });
}

async function applyMigration(
  migration: ConfigMigration,
  agentSlugs: string[],
  mode: MigrationMode,
): Promise<boolean> {
  // Check if migration should be cancelled
  if (mode === "cancel") {
    return false;
  }

  // Prompt for step-through mode
  if (mode === "step-through") {
    const shouldApply = await shouldApplyMigration(migration);
    if (!shouldApply) {
      info(`  Skipped migration ${colors.path(migration.id)}`);
      return false;
    }
  }

  info(`  Applying migration ${colors.path(migration.id)}...`);

  // Apply to global configs
  const globalConfigFiles = ["integrations.toml", "engine.toml"] as const;
  for (const filename of globalConfigFiles) {
    if (migration.targets.includes(filename)) {
      const configPath = join(root(), "config", filename);
      const context: MigrationContext = {
        configPath,
        configType: "global",
      };
      await applyMigrationToFile(migration, configPath, context);
    }
  }

  // Apply to agent configs
  for (const slug of agentSlugs) {
    for (const target of migration.targets) {
      let configPath: string | undefined = undefined;

      if (target === "channels/discord.toml") {
        configPath = join(root(), "agents", slug, "config", "channels", "discord.toml");
      } else if (target !== "integrations.toml") {
        // engine.toml, tools.toml, heartbeat.toml, cron.toml
        configPath = join(root(), "agents", slug, "config", target);
      }

      if (configPath !== undefined) {
        const context: MigrationContext = {
          agentSlug: slug,
          configPath,
          configType: "agent",
        };
        await applyMigrationToFile(migration, configPath, context);
      }
    }
  }

  info(`  ${colors.success("✓")} Applied migration ${colors.path(migration.id)}`);
  return true;
}

export async function runMigrations(): Promise<void> {
  const state = await getMigrationState();
  const migrations = await loadMigrations();

  // Filter out already applied migrations
  const appliedSet = new Set(state.applied);
  const pendingMigrations = migrations.filter((migration) => !appliedSet.has(migration.id));

  if (pendingMigrations.length === 0) {
    return;
  }

  // Get all agent slugs
  const agentsDir = join(root(), "agents");
  let agentSlugs: string[] = [];

  if (existsSync(agentsDir)) {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    agentSlugs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  // Prompt user for mode
  const mode = await promptForMode(pendingMigrations);

  if (mode === "cancel") {
    info("  Migrations cancelled. Exiting.");
    throw new Error("Migrations cancelled by user");
  }

  // Apply migrations
  const newlyApplied: string[] = [];

  for (const migration of pendingMigrations) {
    const applied = await applyMigration(migration, agentSlugs, mode);
    if (applied) {
      newlyApplied.push(migration.id);
    }
  }

  // Update state
  if (newlyApplied.length > 0) {
    state.applied.push(...newlyApplied);
    await saveMigrationState(state);
    info(`  ${colors.success("✓")} Applied ${colors.number(newlyApplied.length)} migration(s)`);
  }

  info("");
}
