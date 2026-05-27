import * as vb from "valibot";
import { describe, expect, it } from "vitest";

import { ProviderConfigSchema } from "#config/schemas/engine.js";
import type { Message } from "#engine/message.js";

import { parseAuthorizationInput } from "./openai-codex-auth.js";
import {
  OPENAI_CODEX_MODELS,
  normalizeCodexModel,
  parseCodexResponse,
  resolveCodexReasoning,
  translateCodexOutput,
  translateMessagesForCodex,
} from "./openai-codex.js";

describe("OpenAI Codex OAuth helpers", () => {
  it("parses callback URLs and manual code formats", () => {
    expect(
      parseAuthorizationInput("http://localhost:1455/auth/callback?code=abc&state=def"),
    ).toEqual({
      code: "abc",
      state: "def",
    });
    expect(parseAuthorizationInput("code=abc&state=def")).toEqual({ code: "abc", state: "def" });
    expect(parseAuthorizationInput("abc#def")).toEqual({ code: "abc", state: "def" });
    expect(parseAuthorizationInput("abc")).toEqual({ code: "abc" });
  });
});

describe("OpenAI Codex provider", () => {
  it("accepts openai-codex engine configuration", () => {
    expect(
      vb.parse(ProviderConfigSchema, {
        apiBase: "https://chatgpt.com/backend-api",
        authId: "personal",
        defaultModel: "gpt-5.1-codex-medium",
        kind: "openai-codex",
      }),
    ).toMatchObject({ authId: "personal", kind: "openai-codex" });
  });

  it("normalizes configured variant models to backend model IDs", () => {
    expect(normalizeCodexModel("gpt-5.1-codex-low")).toBe("gpt-5.1-codex");
    expect(normalizeCodexModel("openai/gpt-5.2-codex-xhigh")).toBe("gpt-5.2-codex");
    expect(normalizeCodexModel("gpt-5.5-codex-high")).toBe("gpt-5.5-codex");
    expect(normalizeCodexModel("gpt 5.4 none")).toBe("gpt-5.4");
    expect(normalizeCodexModel("gpt-5-codex-mini-high")).toBe("gpt-5.1-codex-mini");
  });

  it("keeps reasoning effort inside model-supported values", () => {
    expect(resolveCodexReasoning("gpt-5.1-codex-mini", "low").effort).toBe("medium");
    expect(resolveCodexReasoning("gpt-5.1-codex", "xhigh").effort).toBe("high");
    expect(resolveCodexReasoning("gpt-5.2", false).effort).toBe("none");
    expect(resolveCodexReasoning("gpt-5.2-codex", false).effort).toBe("low");
    expect(resolveCodexReasoning("gpt-5.5-codex", "xhigh").effort).toBe("xhigh");
  });

  it("exposes GPT-5.5 presets for provider model selection", () => {
    expect(OPENAI_CODEX_MODELS).toContain("gpt-5.5-none");
    expect(OPENAI_CODEX_MODELS).toContain("gpt-5.5-xhigh");
    expect(OPENAI_CODEX_MODELS).toContain("gpt-5.5-codex-xhigh");
  });

  it("translates internal messages to stateless Responses API input", async () => {
    const messages: Message[] = [
      { content: { content: "Hello", type: "text" }, role: "user" },
      {
        content: [
          { data: "opaque", type: "redacted_thinking" },
          { id: "call_1", input: { path: "/workspace" }, name: "read", type: "toolCall" },
        ],
        role: "assistant",
      },
      {
        content: { id: "call_1", name: "read", output: { text: "ok" }, type: "toolResponse" },
        role: "toolResponse",
      },
    ];

    await expect(translateMessagesForCodex(messages)).resolves.toEqual([
      {
        content: [{ text: "Hello", type: "input_text" }],
        role: "user",
        type: "message",
      },
      { encrypted_content: "opaque", summary: [], type: "reasoning" },
      {
        arguments: '{"path":"/workspace"}',
        call_id: "call_1",
        name: "read",
        type: "function_call",
      },
      {
        call_id: "call_1",
        output: '{"name":"read","text":"ok"}',
        type: "function_call_output",
      },
    ]);
  });

  it("parses SSE response.completed events", async () => {
    const response = new Response(
      'data: {"type":"response.completed","response":{"output":[{"arguments":"{}","call_id":"call_1","name":"respond","type":"function_call"}]}}\n',
      { headers: { "content-type": "text/event-stream" } },
    );

    await expect(parseCodexResponse(response)).resolves.toEqual({
      output: [{ arguments: "{}", call_id: "call_1", name: "respond", type: "function_call" }],
    });
  });

  it("reconstructs SSE streams that only emit output item done events", async () => {
    const response = new Response(
      'event: response.output_item.done\ndata:{"type":"response.output_item.done","output_index":0,"item":{"arguments":"{}","call_id":"call_1","name":"respond","type":"function_call"}}\n',
      { headers: { "content-type": "text/event-stream" } },
    );

    await expect(parseCodexResponse(response)).resolves.toEqual({
      output: [{ arguments: "{}", call_id: "call_1", name: "respond", type: "function_call" }],
    });
  });

  it("preserves encrypted reasoning and function calls from Codex output", () => {
    const result = translateCodexOutput(
      {
        output: [
          { encrypted_content: "opaque", summary: [], type: "reasoning" },
          {
            arguments: '{"path":"/workspace"}',
            call_id: "call_1",
            name: "read",
            type: "function_call",
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      40,
    );

    expect(result).toEqual({
      message: {
        content: [
          { data: "opaque", type: "redacted_thinking" },
          { id: "call_1", input: { path: "/workspace" }, name: "read", type: "toolCall" },
        ],
        role: "assistant",
      },
      usage: { completionTokens: 5, promptTokens: 10, systemPromptTokensEst: 10 },
    });
  });

  it("accepts JSON event envelopes returned by the Codex backend", () => {
    const result = translateCodexOutput(
      {
        response: {
          output: [
            {
              arguments: '{"path":"/workspace"}',
              call_id: "call_1",
              name: "read",
              type: "function_call",
            },
          ],
        },
        type: "response.completed",
      },
      0,
    );

    expect(result.message).toEqual({
      content: [{ id: "call_1", input: { path: "/workspace" }, name: "read", type: "toolCall" }],
      role: "assistant",
    });
  });

  it("accepts doubly wrapped event envelopes", () => {
    const result = translateCodexOutput(
      {
        data: {
          response: {
            output: [
              {
                arguments: "{}",
                call_id: "call_1",
                name: "respond",
                type: "function_call",
              },
            ],
          },
        },
      },
      0,
    );

    expect(result.message).toEqual({
      content: [{ id: "call_1", input: {}, name: "respond", type: "toolCall" }],
      role: "assistant",
    });
  });
});
