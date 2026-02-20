import * as vb from "valibot";

const nonEmptyString = vb.pipe(vb.string(), vb.nonEmpty());

const EngineOverrideSchema = vb.partial(
  vb.strictObject({
    apiBase: vb.pipe(nonEmptyString, vb.url()),
    apiKey: nonEmptyString,
    model: nonEmptyString,
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
  apiKey: vb.exactOptional(nonEmptyString, "not-needed"),
  channel: vb.exactOptional(EngineOverridesSchema, {}),
  model: nonEmptyString,
});

type EngineConfig = vb.InferOutput<typeof EngineConfigSchema>;

const ExecToolConfigSchema = vb.strictObject({
  binaries: vb.array(vb.pipe(vb.string(), vb.nonEmpty())),
  enabled: vb.exactOptional(vb.boolean(), true),
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
      apiKey: vb.pipe(vb.string(), vb.nonEmpty()),
    }),
  ),
});
type IntegrationsConfig = vb.InferOutput<typeof IntegrationsConfigSchema>;

const DiscordSchema = vb.strictObject({
  ownerId: vb.pipe(vb.string(), vb.nonEmpty(), vb.regex(/[0-9]+/)),
  token: vb.pipe(vb.string(), vb.nonEmpty()),
});
type DiscordConfig = vb.InferOutput<typeof DiscordSchema>;
const MatrixSchema = vb.strictObject({});
type MatrixConfig = vb.InferOutput<typeof MatrixSchema>;

interface ChannelConfigMap {
  discord: DiscordConfig;
  matrix: MatrixConfig;
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
  EngineOverrideSchema,
  ToolConfigSchema,
  ToolsConfigSchema,
  EngineConfigSchema,
  EngineOverridesSchema,
  ExecToolConfigSchema,
  IntegrationsConfigSchema,
  DiscordSchema,
  MatrixSchema,
};

export type {
  ToolsConfig,
  ExecToolConfig,
  ToolConfig,
  EngineOverride,
  EngineOverrides,
  EngineConfig,
  IntegrationsConfig,
  ChannelConfigMap,
  ConfigChangeEvent,
  Watchers,
};
