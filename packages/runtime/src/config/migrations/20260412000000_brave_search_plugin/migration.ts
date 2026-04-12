import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ConfigMigration, MigrationContext } from "$/config/migrations/index.js";
import { root } from "$/util/paths.js";
import { parse, stringify } from "smol-toml";
import type { TomlTable } from "smol-toml";
import * as vb from "valibot";

const OldIntegrationsSchema = vb.partial(
  vb.strictObject({
    brave: vb.strictObject({
      apiKey: vb.union([
        vb.pipe(vb.string(), vb.nonEmpty()),
        vb.pipe(vb.array(vb.pipe(vb.string(), vb.nonEmpty())), vb.minLength(1)),
      ]),
    }),
  }),
);

export const migration: ConfigMigration = {
  description: "Migrate brave-search from integrations.toml to plugin config",
  id: "20260412000000_brave_search_plugin",

  targets: ["integrations.toml", "plugins.toml"],

  async transform(data: TomlTable, context: MigrationContext): Promise<TomlTable> {
    if (!context.configPath.endsWith("integrations.toml")) {
      return data;
    }

    const parsed = vb.safeParse(OldIntegrationsSchema, data);
    if (!parsed.success || parsed.output.brave === undefined) {
      return data;
    }

    const { apiKey } = parsed.output.brave;

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
          : `apiKey = [${apiKey.map((key) => `"${key}"`).join(", ")}]\n`;
      await writeFile(pluginConfigPath, apiKeyToml, "utf8");
    }

    const pluginsTomlPath = join(root(), "config", "plugins.toml");
    await context.backupFile(pluginsTomlPath);

    let pluginsToml: Record<string, unknown> = {};
    if (existsSync(pluginsTomlPath)) {
      const content = await readFile(pluginsTomlPath, "utf8");
      pluginsToml = parse(content) as Record<string, unknown>;
    }

    const plugins = vb.parse(
      vb.exactOptional(vb.array(vb.record(vb.string(), vb.unknown())), []),
      pluginsToml["plugins"],
    );
    const hasBrave = plugins.some(
      (pth) =>
        typeof pth === "object" && "path" in pth && String(pth["path"]).includes("brave-search"),
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
