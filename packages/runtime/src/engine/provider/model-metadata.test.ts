import { describe, expect, it } from "vitest";

import { parseAnthropicModelMetadata, parseOpenAIModelMetadata } from "./model-metadata.js";

describe("parseOpenAIModelMetadata", () => {
  it("extracts OpenRouter context_length before provider fallback", () => {
    const models = parseOpenAIModelMetadata({
      data: [
        {
          context_length: 128_000,
          id: "openrouter/model-a",
          name: "Model A",
          top_provider: { context_length: 64_000 },
        },
      ],
    });

    expect(models).toEqual([{ contextWindow: 128_000, id: "openrouter/model-a", name: "Model A" }]);
  });

  it("extracts OpenRouter top_provider context_length fallback", () => {
    const models = parseOpenAIModelMetadata({
      data: [
        {
          id: "openrouter/model-b",
          top_provider: { context_length: 64_000 },
        },
      ],
    });

    expect(models).toEqual([
      { contextWindow: 64_000, id: "openrouter/model-b", name: "openrouter/model-b" },
    ]);
  });

  it("does not invent context windows for generic OpenAI model payloads", () => {
    const models = parseOpenAIModelMetadata({
      data: [{ id: "gpt-example" }],
    });

    expect(models).toEqual([{ contextWindow: undefined, id: "gpt-example", name: "gpt-example" }]);
  });
  it("treats null context_length as absent and falls back", () => {
    // oxlint-disable unicorn/no-null
    const models = parseOpenAIModelMetadata({
      data: [
        {
          context_length: null,
          id: "openrouter/model-c",
          name: "Model C",
          top_provider: { context_length: 32_000 },
        },
      ],
    });
    // oxlint-enable unicorn/no-null

    expect(models).toEqual([{ contextWindow: 32_000, id: "openrouter/model-c", name: "Model C" }]);
  });

  it("treats all-null numeric fields as absent", () => {
    // oxlint-disable unicorn/no-null
    const models = parseOpenAIModelMetadata({
      data: [
        {
          context_length: null,
          id: "openrouter/model-d",
          max_input_tokens: null,
          top_provider: { context_length: null },
        },
      ],
    });
    // oxlint-enable unicorn/no-null

    expect(models).toEqual([
      { contextWindow: undefined, id: "openrouter/model-d", name: "openrouter/model-d" },
    ]);
  });
});

describe("parseAnthropicModelMetadata", () => {
  it("extracts max_input_tokens", () => {
    const models = parseAnthropicModelMetadata({
      data: [{ id: "claude-example", max_input_tokens: 200_000 }],
    });

    expect(models).toEqual([
      { contextWindow: 200_000, id: "claude-example", name: "claude-example" },
    ]);
  });
});
