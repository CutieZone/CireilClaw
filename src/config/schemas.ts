import * as vb from "valibot";

const nonEmptyString = vb.pipe(vb.string(), vb.nonEmpty());

// API key can be a single string or an array of strings for failover
const ApiKeySchema = vb.union([nonEmptyString, vb.pipe(vb.array(nonEmptyString), vb.minLength(1))]);

type ApiKey = vb.InferOutput<typeof ApiKeySchema>;

const EngineOverrideSchema = vb.partial(
  vb.strictObject({
    apiBase: vb.pipe(nonEmptyString, vb.url()),
    apiKey: ApiKeySchema,
    model: nonEmptyString,
    provider: vb.exactOptional(nonEmptyString, "openai"),
  }),
);

type EngineOverride = vb.InferOutput<typeof EngineOverrideSchema>;

const DiscordOverride = vb.strictObject({
  guild: vb.exactOptional(vb.record(nonEmptyString, EngineOverrideSchema)),
});

const MatrixOverride = vb.exactOptional(vb.record(nonEmptyString, EngineOverrideSchema));

const EngineOverridesSchema = vb.partial(
  vb.strictObject({
    discord: vb.exactOptional(DiscordOverride),
    matrix: vb.exactOptional(MatrixOverride),
  }),
);

type EngineOverrides = vb.InferOutput<typeof EngineOverridesSchema>;

const EngineConfigSchema = vb.strictObject({
  apiBase: vb.pipe(nonEmptyString, vb.url()),
  apiKey: vb.exactOptional(ApiKeySchema, "not-needed"),
  channel: vb.exactOptional(EngineOverridesSchema, {}),
  maxGenerationRetries: vb.exactOptional(vb.pipe(vb.number(), vb.integer(), vb.minValue(0)), 2),
  maxTurns: vb.exactOptional(vb.pipe(vb.number(), vb.integer(), vb.minValue(1)), 30),
  minP: vb.exactOptional(vb.pipe(vb.number(), vb.minValue(0), vb.maxValue(1))),
  model: nonEmptyString,
  presencePenalty: vb.exactOptional(vb.pipe(vb.number(), vb.minValue(-2), vb.maxValue(2))),
  provider: vb.exactOptional(nonEmptyString, "openai"),
  temperature: vb.exactOptional(vb.pipe(vb.number(), vb.minValue(0), vb.maxValue(2))),
  toolFailThreshold: vb.exactOptional(vb.pipe(vb.number(), vb.integer(), vb.minValue(1)), 3),
  topP: vb.exactOptional(vb.pipe(vb.number(), vb.minValue(0), vb.maxValue(1))),
});

type EngineConfig = vb.InferOutput<typeof EngineConfigSchema>;

const ExecToolConfigSchema = vb.strictObject({
  binaries: vb.array(vb.pipe(vb.string(), vb.nonEmpty())),
  enabled: vb.exactOptional(vb.boolean(), true),
  hostEnvPassthrough: vb.exactOptional(vb.array(vb.pipe(vb.string(), vb.nonEmpty())), []),
  timeout: vb.exactOptional(vb.pipe(vb.number(), vb.integer(), vb.minValue(1000)), 60_000),
});

type ExecToolConfig = vb.InferOutput<typeof ExecToolConfigSchema>;

const ToolConfigSchema = vb.union([vb.boolean(), ExecToolConfigSchema]);

type ToolConfig = vb.InferOutput<typeof ToolConfigSchema>;

const ToolsConfigSchema = vb.record(
  vb.pipe(vb.string(), vb.nonEmpty()),
  vb.exactOptional(ToolConfigSchema, true),
);

type ToolsConfig = vb.InferOutput<typeof ToolsConfigSchema>;

const IntegrationsConfigSchema = vb.strictObject({
  brave: vb.exactOptional(
    vb.strictObject({
      apiKey: ApiKeySchema,
    }),
  ),
});
type IntegrationsConfig = vb.InferOutput<typeof IntegrationsConfigSchema>;

const SystemConfigSchema = vb.strictObject({
  timezone: vb.exactOptional(vb.pipe(vb.string(), vb.nonEmpty())),
});
type SystemConfig = vb.InferOutput<typeof SystemConfigSchema>;

const DirectMessagesModeSchema = vb.exactOptional(
  vb.union([vb.literal("owner"), vb.literal("public"), vb.literal("whitelist")]),
  "owner",
);

type DirectMessagesMode = vb.InferOutput<typeof DirectMessagesModeSchema>;

const AccessModeSchema = vb.exactOptional(
  vb.union([vb.literal("disabled"), vb.literal("whitelist"), vb.literal("blacklist")]),
  "disabled",
);

type AccessMode = vb.InferOutput<typeof AccessModeSchema>;

const AccessSchema = vb.optional(
  vb.strictObject({
    mode: AccessModeSchema,
    users: vb.exactOptional(vb.array(vb.pipe(vb.string(), vb.regex(/[0-9]+/))), []),
  }),
);

type AccessConfig = vb.InferOutput<typeof AccessSchema>;

const DirectMessagesSchema = vb.optional(
  vb.strictObject({
    mode: DirectMessagesModeSchema,
    users: vb.exactOptional(vb.array(vb.pipe(vb.string(), vb.regex(/[0-9]+/))), []),
  }),
);

type DirectMessagesConfig = vb.InferOutput<typeof DirectMessagesSchema>;

const DiscordSchema = vb.strictObject({
  access: vb.exactOptional(AccessSchema, { mode: "disabled", users: [] }),
  directMessages: vb.exactOptional(DirectMessagesSchema, { mode: "owner", users: [] }),
  ownerId: vb.pipe(vb.string(), vb.nonEmpty(), vb.regex(/[0-9]+/)),
  token: vb.pipe(vb.string(), vb.nonEmpty()),
});
type DiscordConfig = vb.InferOutput<typeof DiscordSchema>;
const MatrixSchema = vb.strictObject({});
type MatrixConfig = vb.InferOutput<typeof MatrixSchema>;

const TuiSchema = vb.strictObject({});
type TuiConfig = vb.InferOutput<typeof TuiSchema>;

interface ChannelConfigMap {
  discord: DiscordConfig;
  matrix: MatrixConfig;
  tui: TuiConfig;
  // oxlint-disable-next-line typescript/no-invalid-void-type
  internal: void;
}

interface ConfigChangeEvent {
  eventType: "change" | "rename";
  filename: string | null;
  basePath: string;
}

type Watchers = AsyncIterableIterator<ConfigChangeEvent>;

export {
  AccessSchema,
  ApiKeySchema,
  DirectMessagesSchema,
  DiscordSchema,
  EngineConfigSchema,
  EngineOverrideSchema,
  EngineOverridesSchema,
  ExecToolConfigSchema,
  IntegrationsConfigSchema,
  MatrixSchema,
  SystemConfigSchema,
  ToolConfigSchema,
  ToolsConfigSchema,
  TuiSchema,
};

export type {
  AccessConfig,
  AccessMode,
  ApiKey,
  ChannelConfigMap,
  ConfigChangeEvent,
  DirectMessagesConfig,
  DirectMessagesMode,
  EngineConfig,
  EngineOverride,
  EngineOverrides,
  ExecToolConfig,
  IntegrationsConfig,
  SystemConfig,
  ToolConfig,
  ToolsConfig,
  Watchers,
};
