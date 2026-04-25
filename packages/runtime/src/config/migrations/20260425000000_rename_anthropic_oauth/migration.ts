import type { TomlTable } from "smol-toml";

import type { ConfigMigration } from "#config/migrations/index.js";

export const migration: ConfigMigration = {
  description: 'Rename provider kind "anthropic-oauth" to "anthropic"',
  id: "20260425000000_rename_anthropic_oauth",
  targets: ["engine.toml"],

  transform(data: TomlTable): TomlTable {
    for (const [_key, value] of Object.entries(data)) {
      if (
        typeof value === "object" &&
        !Array.isArray(value) &&
        "kind" in value &&
        value["kind"] === "anthropic-oauth"
      ) {
        (value as Record<string, unknown>)["kind"] = "anthropic";
      }
    }

    return data;
  },
};
