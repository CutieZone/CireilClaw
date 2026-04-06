import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ConfigMigration, MigrationContext } from "$/config/migrations/index.js";
import type { TomlTable } from "smol-toml";
import * as vb from "valibot";

interface OverrideInfo {
  id: string;
  modelName: string;
  providerName: string;
  type: "discord" | "matrix";
}

const baseConfigs = new Map<
  string,
  {
    baseConfig: Record<string, unknown>;
    baseModelConfig: Record<string, unknown>;
  }
>();
const extraProviders = new Map<string, Record<string, unknown>>();
const dbUpdates = new Map<string, OverrideInfo[]>();

function cleanUndefined(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => cleanUndefined(item));
  }

  const record = vb.parse(vb.record(vb.string(), vb.unknown()), obj);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      result[key] = cleanUndefined(value);
    }
  }
  return result;
}

const ApiKeySchema = vb.union([vb.string(), vb.array(vb.string())]);

const OldEngineOverrideSchema = vb.looseObject({
  apiBase: vb.exactOptional(vb.string()),
  apiKey: vb.exactOptional(ApiKeySchema),
  model: vb.exactOptional(vb.string()),
  provider: vb.exactOptional(vb.string()),
  supportsVideo: vb.exactOptional(vb.boolean()),
  thinkingBudget: vb.exactOptional(vb.number()),
  toolFailThreshold: vb.exactOptional(vb.number()),
  useJpegForImages: vb.exactOptional(vb.boolean()),
});

const OldEngineConfigSchema = vb.looseObject({
  apiBase: vb.exactOptional(vb.string(), "http://localhost"),
  apiKey: vb.exactOptional(ApiKeySchema),
  channel: vb.exactOptional(
    vb.looseObject({
      discord: vb.exactOptional(
        vb.looseObject({
          guild: vb.exactOptional(vb.record(vb.string(), OldEngineOverrideSchema)),
        }),
      ),
      matrix: vb.exactOptional(vb.record(vb.string(), OldEngineOverrideSchema)),
    }),
  ),
  maxGenerationRetries: vb.exactOptional(vb.number()),
  maxTurns: vb.exactOptional(vb.number()),
  model: vb.exactOptional(vb.string(), "default-model"),
  provider: vb.exactOptional(vb.string()),
  supportsVideo: vb.exactOptional(vb.boolean()),
  thinkingBudget: vb.exactOptional(vb.number()),
  toolFailThreshold: vb.exactOptional(vb.number()),
  useJpegForImages: vb.exactOptional(vb.boolean()),
});

const OldCronJobConfigSchema = vb.record(
  vb.string(),
  vb.looseObject({
    model: vb.exactOptional(vb.union([vb.string(), OldEngineOverrideSchema])),
    provider: vb.exactOptional(vb.string()),
  }),
);

const OldHeartbeatConfigSchema = vb.looseObject({
  model: vb.exactOptional(vb.union([vb.string(), OldEngineOverrideSchema])),
  provider: vb.exactOptional(vb.string()),
});

const SessionMetaSchema = vb.looseObject({
  guildId: vb.exactOptional(vb.string()),
  roomId: vb.exactOptional(vb.string()),
  selectedModel: vb.exactOptional(vb.string()),
  selectedProvider: vb.exactOptional(vb.string()),
});

export const migration: ConfigMigration = {
  description: "Migrate engine config to provider-based structure and update DB overrides",
  id: "20260406000000_engine_providers",

  async migrateAgent(agentSlug, agentPath, context) {
    const extra = extraProviders.get(agentSlug);
    if (extra !== undefined && Object.keys(extra).length > 0) {
      const enginePath = join(agentPath, "config", "engine.toml");
      if (existsSync(enginePath)) {
        await context.backupFile(enginePath);
        const { parse, stringify } = await import("smol-toml");
        const content = await readFile(enginePath, "utf8");
        const parsed = parse(content);
        Object.assign(parsed as Record<string, unknown>, extra);
        await writeFile(enginePath, stringify(parsed), "utf8");
      }
    }

    const updates = [...(dbUpdates.get("global") ?? []), ...(dbUpdates.get(agentSlug) ?? [])];
    if (updates.length > 0) {
      const { initDb } = await import("$/db/index.js");
      const { sessions } = await import("$/db/schema.js");
      const { eq } = await import("drizzle-orm");

      const db = initDb(agentSlug);
      const allSessions = await db.select().from(sessions);

      for (const session of allSessions) {
        if (session.channel === "discord") {
          const parseResult = vb.safeParse(SessionMetaSchema, JSON.parse(session.meta));
          if (parseResult.success) {
            const meta = parseResult.output;
            const { guildId } = meta;
            const update = updates.find((item) => item.type === "discord" && item.id === guildId);
            if (update !== undefined) {
              meta.selectedProvider = update.providerName;
              meta.selectedModel = update.modelName;
              await db
                .update(sessions)
                .set({ meta: JSON.stringify(meta) })
                .where(eq(sessions.id, session.id));
            }
          }
        } else if (session.channel === "matrix") {
          const parseResult = vb.safeParse(SessionMetaSchema, JSON.parse(session.meta));
          if (parseResult.success) {
            const meta = parseResult.output;
            const { roomId } = meta;
            const update = updates.find((item) => item.type === "matrix" && item.id === roomId);
            if (update !== undefined) {
              meta.selectedProvider = update.providerName;
              meta.selectedModel = update.modelName;
              await db
                .update(sessions)
                .set({ meta: JSON.stringify(meta) })
                .where(eq(sessions.id, session.id));
            }
          }
        }
      }
    }
  },

  targets: ["engine.toml", "cron.toml", "heartbeat.toml", "channels/discord.toml"],

  transform(rawData: TomlTable, context: MigrationContext): TomlTable {
    const agentId = context.agentSlug ?? "global";

    if (context.configPath.endsWith("engine.toml")) {
      const parseResult = vb.safeParse(OldEngineConfigSchema, rawData);
      if (!parseResult.success) {
        return rawData;
      }

      const data = parseResult.output;

      const baseConfig: Record<string, unknown> = {
        apiBase: data.apiBase,
        apiKey: data.apiKey,
        defaultModel: data.model,
        kind: data.provider ?? "openai",
      };
      if (data.maxGenerationRetries !== undefined) {
        baseConfig["maxGenerationRetries"] = data.maxGenerationRetries;
      }
      if (data.maxTurns !== undefined) {
        baseConfig["maxTurns"] = data.maxTurns;
      }
      if (data.useJpegForImages !== undefined) {
        baseConfig["useJpegForImages"] = data.useJpegForImages;
      }

      const defaultBudget = data.thinkingBudget ?? 16_384;
      const baseModelConfig: Record<string, unknown> = {
        reasoning: defaultBudget > 0,
      };

      if (data.thinkingBudget !== undefined) {
        baseModelConfig["reasoningBudget"] = data.thinkingBudget;
      }
      if (data.supportsVideo !== undefined) {
        baseModelConfig["supportsVideo"] = data.supportsVideo;
      }
      if (data.toolFailThreshold !== undefined) {
        baseModelConfig["toolFailThreshold"] = data.toolFailThreshold;
      }

      baseConfigs.set(agentId, { baseConfig, baseModelConfig });
      if (!dbUpdates.has(agentId)) {
        dbUpdates.set(agentId, []);
      }

      const defaultModelName = vb.parse(vb.string(), baseConfig["defaultModel"]);
      const newData: Record<string, unknown> = {
        default: {
          ...baseConfig,
          isGlobalDefault: true,
          models: {
            [defaultModelName]: baseModelConfig,
          },
        },
      };

      if (data.channel?.discord?.guild) {
        for (const [guildId, overrideRaw] of Object.entries(data.channel.discord.guild)) {
          const providerName = `discord_guild_${guildId}`;
          const modelName = overrideRaw.model ?? defaultModelName;

          const modelOverride: Record<string, unknown> = { ...baseModelConfig };
          if (overrideRaw.thinkingBudget !== undefined) {
            modelOverride["reasoning"] = overrideRaw.thinkingBudget > 0;
            modelOverride["reasoningBudget"] = overrideRaw.thinkingBudget;
          }
          if (overrideRaw.supportsVideo !== undefined) {
            modelOverride["supportsVideo"] = overrideRaw.supportsVideo;
          }
          if (overrideRaw.toolFailThreshold !== undefined) {
            modelOverride["toolFailThreshold"] = overrideRaw.toolFailThreshold;
          }

          const guildProvider: Record<string, unknown> = {
            apiBase: overrideRaw.apiBase ?? baseConfig["apiBase"],
            apiKey: overrideRaw.apiKey ?? baseConfig["apiKey"],
            defaultModel: modelName,
            kind: overrideRaw.provider ?? baseConfig["kind"],
            models: {
              [modelName]: modelOverride,
            },
            useJpegForImages: overrideRaw.useJpegForImages ?? baseConfig["useJpegForImages"],
          };
          if (baseConfig["maxGenerationRetries"] !== undefined) {
            guildProvider["maxGenerationRetries"] = baseConfig["maxGenerationRetries"];
          }
          if (baseConfig["maxTurns"] !== undefined) {
            guildProvider["maxTurns"] = baseConfig["maxTurns"];
          }
          newData[providerName] = guildProvider;

          dbUpdates.get(agentId)?.push({
            id: guildId,
            modelName,
            providerName,
            type: "discord",
          });
        }
      }

      if (data.channel?.matrix) {
        for (const [roomId, overrideRaw] of Object.entries(data.channel.matrix)) {
          const providerName = `matrix_${roomId}`;
          const modelName = overrideRaw.model ?? defaultModelName;

          const modelOverride: Record<string, unknown> = { ...baseModelConfig };
          if (overrideRaw.thinkingBudget !== undefined) {
            modelOverride["reasoning"] = overrideRaw.thinkingBudget > 0;
            modelOverride["reasoningBudget"] = overrideRaw.thinkingBudget;
          }
          if (overrideRaw.supportsVideo !== undefined) {
            modelOverride["supportsVideo"] = overrideRaw.supportsVideo;
          }
          if (overrideRaw.toolFailThreshold !== undefined) {
            modelOverride["toolFailThreshold"] = overrideRaw.toolFailThreshold;
          }

          const roomProvider: Record<string, unknown> = {
            apiBase: overrideRaw.apiBase ?? baseConfig["apiBase"],
            apiKey: overrideRaw.apiKey ?? baseConfig["apiKey"],
            defaultModel: modelName,
            kind: overrideRaw.provider ?? baseConfig["kind"],
            models: {
              [modelName]: modelOverride,
            },
            useJpegForImages: overrideRaw.useJpegForImages ?? baseConfig["useJpegForImages"],
          };
          if (baseConfig["maxGenerationRetries"] !== undefined) {
            roomProvider["maxGenerationRetries"] = baseConfig["maxGenerationRetries"];
          }
          if (baseConfig["maxTurns"] !== undefined) {
            roomProvider["maxTurns"] = baseConfig["maxTurns"];
          }
          newData[providerName] = roomProvider;

          dbUpdates.get(agentId)?.push({
            id: roomId,
            modelName,
            providerName,
            type: "matrix",
          });
        }
      }

      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return cleanUndefined(newData) as TomlTable;
    }

    if (context.configPath.endsWith("cron.toml")) {
      const base = baseConfigs.get(agentId) ?? baseConfigs.get("global");
      if (!base) {
        return rawData;
      }

      const parseResult = vb.safeParse(OldCronJobConfigSchema, rawData);
      if (!parseResult.success) {
        return rawData;
      }

      const data = parseResult.output;
      const agentExtra = extraProviders.get(agentId) ?? {};
      const defaultModelName = vb.parse(vb.string(), base.baseConfig["defaultModel"]);

      for (const [jobKey, jobConfigRaw] of Object.entries(data)) {
        if (typeof jobConfigRaw.model === "object") {
          const override = jobConfigRaw.model;
          const providerName = `cron_${jobKey}`;
          const modelName = override.model ?? defaultModelName;

          const modelOverride: Record<string, unknown> = {
            ...base.baseModelConfig,
          };
          if (override.thinkingBudget !== undefined) {
            modelOverride["reasoning"] = override.thinkingBudget > 0;
            modelOverride["reasoningBudget"] = override.thinkingBudget;
          }
          if (override.supportsVideo !== undefined) {
            modelOverride["supportsVideo"] = override.supportsVideo;
          }
          if (override.toolFailThreshold !== undefined) {
            modelOverride["toolFailThreshold"] = override.toolFailThreshold;
          }

          agentExtra[providerName] = {
            apiBase: override.apiBase ?? base.baseConfig["apiBase"],
            apiKey: override.apiKey ?? base.baseConfig["apiKey"],
            defaultModel: modelName,
            kind: override.provider ?? base.baseConfig["kind"],
            models: {
              [modelName]: modelOverride,
            },
            useJpegForImages: override.useJpegForImages ?? base.baseConfig["useJpegForImages"],
          };

          jobConfigRaw.model = modelName;
          jobConfigRaw.provider = providerName;
        }
      }
      extraProviders.set(agentId, agentExtra);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return cleanUndefined(data) as TomlTable;
    }

    if (context.configPath.endsWith("heartbeat.toml")) {
      const base = baseConfigs.get(agentId) ?? baseConfigs.get("global");
      if (!base) {
        return rawData;
      }

      const parseResult = vb.safeParse(OldHeartbeatConfigSchema, rawData);
      if (!parseResult.success) {
        return rawData;
      }

      const data = parseResult.output;
      const agentExtra = extraProviders.get(agentId) ?? {};
      const defaultModelName = vb.parse(vb.string(), base.baseConfig["defaultModel"]);

      if (typeof data.model === "object") {
        const override = data.model;
        const providerName = "heartbeat";
        const modelName = override.model ?? defaultModelName;

        const modelOverride: Record<string, unknown> = {
          ...base.baseModelConfig,
        };
        if (override.thinkingBudget !== undefined) {
          modelOverride["reasoning"] = override.thinkingBudget > 0;
          modelOverride["reasoningBudget"] = override.thinkingBudget;
        }
        if (override.supportsVideo !== undefined) {
          modelOverride["supportsVideo"] = override.supportsVideo;
        }
        if (override.toolFailThreshold !== undefined) {
          modelOverride["toolFailThreshold"] = override.toolFailThreshold;
        }

        agentExtra[providerName] = {
          apiBase: override.apiBase ?? base.baseConfig["apiBase"],
          apiKey: override.apiKey ?? base.baseConfig["apiKey"],
          defaultModel: modelName,
          kind: override.provider ?? base.baseConfig["kind"],
          models: {
            [modelName]: modelOverride,
          },
          useJpegForImages: override.useJpegForImages ?? base.baseConfig["useJpegForImages"],
        };

        data.model = modelName;
        data.provider = providerName;
      }

      extraProviders.set(agentId, agentExtra);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return cleanUndefined(data) as TomlTable;
    }

    if (context.configPath.endsWith("channels/discord.toml")) {
      const { access, directMessages } = rawData;

      if (typeof access === "object" && "mode" in access) {
        const rec = access as Record<string, unknown>;
        if (rec["mode"] === "whitelist") {
          rec["mode"] = "allowlist";
        } else if (rec["mode"] === "blacklist") {
          rec["mode"] = "denylist";
        }
      }

      if (typeof directMessages === "object" && "mode" in directMessages) {
        const rec = directMessages as Record<string, unknown>;
        if (rec["mode"] === "whitelist") {
          rec["mode"] = "allowlist";
        } else if (rec["mode"] === "blacklist") {
          rec["mode"] = "denylist";
        }
      }

      return rawData;
    }

    return rawData;
  },
};
