import { ApiKeySchema, nonEmptyString } from "$/config/schemas/shared.js";
import { ProviderKindSchema } from "$/engine/provider/index.js";
import * as vb from "valibot";

const DefaultReasoningBudget = 16_384;
const DefaultToolFailThreshold = 3;
const DefaultGenerationRetries = 2;
const DefaultMaxTurns = 30;

const ModelConfigSchema = vb.record(
  nonEmptyString,
  vb.strictObject({
    contextBudget: vb.optional(vb.pipe(vb.number(), vb.minValue(0.1), vb.maxValue(1))),
    contextHardBudget: vb.optional(vb.pipe(vb.number(), vb.minValue(0.1), vb.maxValue(1))),
    contextWindow: vb.optional(vb.number()),
    reasoning: vb.exactOptional(vb.boolean(), true),
    reasoningBudget: vb.exactOptional(
      vb.pipe(vb.number(), vb.integer(), vb.minValue(0)),
      DefaultReasoningBudget,
    ),
    supportsVideo: vb.exactOptional(vb.boolean(), false),
    toolFailThreshold: vb.exactOptional(
      vb.pipe(vb.number(), vb.integer(), vb.minValue(1)),
      DefaultToolFailThreshold,
    ),
  }),
);

type ModelConfig = vb.InferOutput<typeof ModelConfigSchema>;

const ProviderConfigSchema = vb.strictObject({
  apiBase: vb.pipe(nonEmptyString, vb.url(), vb.description("A valid API base URL")),
  apiKey: vb.exactOptional(ApiKeySchema, "not-needed"),
  availableModels: vb.pipe(
    vb.exactOptional(
      vb.union([vb.pipe(vb.array(nonEmptyString), vb.minLength(1)), vb.literal("analyze")]),
      "analyze",
    ),
    vb.description(
      "Either a list of available models, or 'analyze' to attempt automatic resolution of a model list",
    ),
  ),
  customHeaders: vb.pipe(
    vb.exactOptional(
      vb.record(nonEmptyString, vb.union([nonEmptyString, vb.array(nonEmptyString)])),
    ),
    vb.description("Optional custom headers to apply to the generation requests to this provider."),
  ),
  defaultModel: vb.pipe(
    vb.pipe(nonEmptyString, vb.minLength(1)),
    vb.description("The default model to use from this provider"),
  ),
  isGlobalDefault: vb.pipe(
    vb.exactOptional(vb.boolean(), false),
    vb.description(
      "Whether this provider is the global default provider. One provider *must* have this.",
    ),
  ),
  kind: vb.pipe(
    vb.exactOptional(ProviderKindSchema, "openai"),
    vb.description("What kind of provider this is"),
  ),
  maxGenerationRetries: vb.pipe(
    vb.exactOptional(vb.pipe(vb.number(), vb.integer(), vb.minValue(0)), DefaultGenerationRetries),
    vb.description("How many times the generation is allowed to fail before we crash out"),
  ),
  maxTurns: vb.pipe(
    vb.exactOptional(vb.pipe(vb.number(), vb.integer(), vb.minValue(1)), DefaultMaxTurns),
    vb.description("How many turns of conversation is sent to the inference endpoint"),
  ),
  models: vb.pipe(
    vb.exactOptional(ModelConfigSchema, undefined),
    vb.description("Model-specific overrides; default values used otherwise"),
  ),
  useJpegForImages: vb.pipe(
    vb.exactOptional(vb.boolean(), false),
    vb.description("Whether to force the use of JPEG over WEBP for images"),
  ),
  useToolChoiceAuto: vb.pipe(
    vb.exactOptional(vb.boolean(), false),
    vb.description("Whether to prefer `tool_choice: auto` over `tool_choice: required`"),
  ),
});

const ProvidersConfigSchema = vb.record(nonEmptyString, ProviderConfigSchema);

type ProviderConfig = vb.InferOutput<typeof ProviderConfigSchema>;
type ProvidersConfig = vb.InferOutput<typeof ProvidersConfigSchema>;

export {
  ProviderConfigSchema,
  ProvidersConfigSchema,
  ModelConfigSchema,
  DefaultReasoningBudget,
  DefaultMaxTurns,
  DefaultGenerationRetries,
  DefaultToolFailThreshold,
};
export type { ProvidersConfig, ProviderConfig, ModelConfig };
