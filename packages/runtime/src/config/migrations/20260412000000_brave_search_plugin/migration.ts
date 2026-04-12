import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ConfigMigration, MigrationContext } from "$/config/migrations/index.js";
import { root } from "$/util/paths.js";
import { parse, stringify } from "smol-toml";
import type { TomlTable } from "smol-toml";

export const migration: ConfigMigration = {
  description: "Migrate brave-search from integrations.toml to plugin config",
  id: "20260412000000_brave_search_plugin",

  targets: ["integrations.toml", "plugins.toml"],

  async transform(data: TomlTable, context: MigrationContext): Promise<TomlTable> {
    if (!context.configPath.endsWith("integrations.toml")) {
      return data;
    }

    const brave = data["brave"] as Record<string, unknown> | undefined;
    if (brave === undefined || brave["apiKey"] === undefined) {
      return data;
    }

    const apiKey = brave["apiKey"] as string | string[];

    const pluginsDir = join(root(), "config", "plugins");
    if (!existsSync(pluginsDir)) {
      await mkdir(pluginsDir, { recursive: true });
    }

    const pluginConfigPath = join(pluginsDir, "brave-search.toml");
    if (!existsSync(pluginConfigPath)) {
      await context.backupFile(pluginConfigPath);
      const apiKeyToml =
        typeof apiKey === "string"
          ? `apiKey = "${apiKey}"\n`
          : `apiKey = [${apiKey.map((k) => `"${k}"`).join(", ")}]\n`;
      await writeFile(pluginConfigPath, apiKeyToml, "utf8");
    }

    const pluginsTomlPath = join(root(), "config", "plugins.toml");
    await context.backupFile(pluginsTomlPath);

    let pluginsToml: Record<string, unknown> = {};
    if (existsSync(pluginsTomlPath)) {
      const content = await readFile(pluginsTomlPath, "utf8");
      pluginsToml = parse(content) as Record<string, unknown>;
    }

    const plugins = (pluginsToml["plugins"] as Record<string, unknown>[] | undefined) ?? [];
    const hasBrave = plugins.some(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        "path" in p &&
        String(p["path"]).includes("brave-search"),
    );

    if (!hasBrave) {
      plugins.push({
        allowOverride: false,
        path: join(root(), "plugins", "brave-search", "src", "index.ts"),
      });
      pluginsToml["plugins"] = plugins;
      await writeFile(pluginsTomlPath, stringify(pluginsToml), "utf8");
    }

    return data;
  },
};
