import type { TomlTable } from "smol-toml";

type MigrationTargets =
  | "channels/discord.toml"
  | "cron.toml"
  | "engine.toml"
  | "heartbeat.toml"
  | "integrations.toml"
  | "plugins.toml"
  | "tools.toml";

interface ConfigMigration {
  description: string;
  id: string; // Format: YYYYMMDDHHMMSS_descriptive_name
  targets: MigrationTargets[];
  transform(data: TomlTable, context: MigrationContext): TomlTable | Promise<TomlTable>;
  migrateAgent?(agentSlug: string, agentPath: string, context: MigrationContext): Promise<void>;
}

interface MigrationContext {
  agentSlug?: string;
  configPath: string;
  configType: "global" | "agent";
  backupFile(filePath: string): Promise<void>;
}

export type { ConfigMigration, MigrationContext };
