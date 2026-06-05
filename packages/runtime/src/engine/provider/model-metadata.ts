import * as vb from "valibot";

import type { ProviderConfig } from "#config/schemas/engine.js";
import { nonEmptyString } from "#config/schemas/shared.js";
import { warning } from "#output/log.js";

import { OPENAI_CODEX_MODELS } from "./openai-codex.js";

interface ModelMetadata {
  id: string;
  name: string;
  contextWindow?: number;
}

type SingleModelConfig = NonNullable<ProviderConfig["models"]>[string];

const PositiveIntegerSchema = vb.pipe(vb.number(), vb.integer(), vb.minValue(1));

const OpenAIModelListSchema = vb.object({
  data: vb.array(
    vb.looseObject({
      context_length: vb.optional(vb.nullable(PositiveIntegerSchema)),
      id: nonEmptyString,
      max_input_tokens: vb.optional(vb.nullable(PositiveIntegerSchema)),
      name: vb.exactOptional(nonEmptyString),
      top_provider: vb.exactOptional(
        vb.looseObject({
          context_length: vb.optional(vb.nullable(PositiveIntegerSchema)),
        }),
      ),
    }),
  ),
});

const AnthropicModelListSchema = vb.object({
  data: vb.array(
    vb.looseObject({
      id: nonEmptyString,
      max_input_tokens: vb.optional(vb.nullable(PositiveIntegerSchema)),
    }),
  ),
});

type OpenAIModelList = vb.InferOutput<typeof OpenAIModelListSchema>;
type AnthropicModelList = vb.InferOutput<typeof AnthropicModelListSchema>;

const metadataCache = new Map<string, Promise<ModelMetadata[]>>();

function modelsUrl(apiBase: string): string {
  return `${apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase}/models`;
}

function firstApiKey(provider: ProviderConfig): string {
  if (Array.isArray(provider.apiKey)) {
    return provider.apiKey[0] ?? "not-needed";
  }
  return provider.apiKey;
}

function applyCustomHeaders(headers: Headers, provider: ProviderConfig): void {
  if (provider.customHeaders === undefined) {
    return;
  }

  for (const [name, value] of Object.entries(provider.customHeaders)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else {
      headers.set(name, value);
    }
  }
}

function cacheKey(provider: ProviderConfig): string {
  return `${provider.kind}:${provider.apiBase}`;
}

function parseOpenAIModelMetadata(json: unknown): ModelMetadata[] {
  const list: OpenAIModelList = vb.parse(OpenAIModelListSchema, json);
  return list.data.map((it) => ({
    contextWindow:
      it.context_length ?? it.top_provider?.context_length ?? it.max_input_tokens ?? undefined,
    id: it.id,
    name: it.name ?? it.id,
  }));
}

function parseAnthropicModelMetadata(json: unknown): ModelMetadata[] {
  const list: AnthropicModelList = vb.parse(AnthropicModelListSchema, json);
  return list.data.map((it) => ({
    contextWindow: it.max_input_tokens ?? undefined,
    id: it.id,
    name: it.id,
  }));
}

async function fetchOpenAIModelMetadata(provider: ProviderConfig): Promise<ModelMetadata[]> {
  const headers = new Headers({ Authorization: `Bearer ${firstApiKey(provider)}` });
  applyCustomHeaders(headers, provider);

  const response = await fetch(modelsUrl(provider.apiBase), { headers });
  if (!response.ok) {
    throw new Error(`model metadata request failed with HTTP ${response.status}`);
  }

  return parseOpenAIModelMetadata(await response.json());
}

async function fetchAnthropicModelMetadata(provider: ProviderConfig): Promise<ModelMetadata[]> {
  const headers = new Headers({
    Authorization: `Bearer ${firstApiKey(provider)}`,
    "Content-Type": "application/json",
    "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
    "anthropic-version": "2023-06-01",
  });
  applyCustomHeaders(headers, provider);

  const response = await fetch(modelsUrl(provider.apiBase), { headers });
  if (!response.ok) {
    throw new Error(`model metadata request failed with HTTP ${response.status}`);
  }

  return parseAnthropicModelMetadata(await response.json());
}

async function fetchModelMetadataUncached(provider: ProviderConfig): Promise<ModelMetadata[]> {
  switch (provider.kind) {
    case "openai":
      return await fetchOpenAIModelMetadata(provider);
    case "anthropic":
      return await fetchAnthropicModelMetadata(provider);
    case "openai-codex":
      return OPENAI_CODEX_MODELS.map((id) => ({ id, name: id }));
    default: {
      const exhaustive: never = provider.kind;
      throw new Error(`Unsupported provider type: ${String(exhaustive)}`);
    }
  }
}

async function fetchModelMetadataCached(
  provider: ProviderConfig,
  key: string,
): Promise<ModelMetadata[]> {
  try {
    return await fetchModelMetadataUncached(provider);
  } catch (error: unknown) {
    metadataCache.delete(key);
    const message = error instanceof Error ? error.message : String(error);
    warning(`Failed to fetch model metadata for ${provider.kind} provider: ${message}`);
    return [];
  }
}

async function fetchModelMetadataFor(provider: ProviderConfig): Promise<ModelMetadata[]> {
  const key = cacheKey(provider);
  const cached = metadataCache.get(key);
  if (cached !== undefined) {
    return await cached;
  }

  const promise = fetchModelMetadataCached(provider, key);
  metadataCache.set(key, promise);
  return await promise;
}

async function resolveModelContextWindow(
  provider: ProviderConfig,
  modelName: string,
  modelCfg: SingleModelConfig,
): Promise<number | undefined> {
  const configuredContextWindow = modelCfg.contextWindow;
  if (configuredContextWindow !== undefined) {
    return configuredContextWindow;
  }

  const metadata = await fetchModelMetadataFor(provider);
  return metadata.find((model) => model.id === modelName)?.contextWindow;
}

function clearModelMetadataCache(): void {
  metadataCache.clear();
}

export {
  clearModelMetadataCache,
  fetchModelMetadataFor,
  parseAnthropicModelMetadata,
  parseOpenAIModelMetadata,
  resolveModelContextWindow,
};
export type { ModelMetadata };
