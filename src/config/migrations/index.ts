import type { TomlTable } from "smol-toml";

type MigrationTargets =
  | "channels/discord.toml"
  | "cron.toml"
  | "engine.toml"
  | "heartbeat.toml"
  | "integrations.toml"
  | "tools.toml";

interface ConfigMigration {
  description: string;
  id: string; // Format: YYYYMMDDHHMMSS_descriptive_name
  targets: MigrationTargets[];
  transform(data: TomlTable, context: MigrationContext): TomlTable | Promise<TomlTable>;
  /** Optional: run arbitrary filesystem operations per agent after TOML transforms. */
  migrateAgent?(agentSlug: string, agentPath: string, context: MigrationContext): Promise<void>;
}

interface MigrationContext {
  agentSlug?: string; // undefined for global configs
  configPath: string;
  configType: "global" | "agent";
  /** Backup a file before modifying it. Safe to call on non-existent files. */
  backupFile(filePath: string): Promise<void>;
}

export type { ConfigMigration, MigrationContext };
