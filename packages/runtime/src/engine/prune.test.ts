import { describe, expect, it } from "vitest";
import { applyReadSupersession, estimateSystemPrompt, estimateTokens } from "./prune.js";
import type { Message } from "./message.js";

describe("estimateTokens", () => {
  it("estimates text messages", () => {
    const messages: Message[] = [
      { content: { content: "Hello world", type: "text" }, role: "user" },
    ];
    expect(estimateTokens(messages)).toBe(8);
  });

  it("estimates tool responses", () => {
    const messages: Message[] = [
      {
        content: {
          id: "call-1",
          name: "read",
          output: { content: "x".repeat(300), path: "/workspace/file.txt", success: true },
          type: "toolResponse",
        },
        role: "toolResponse",
      },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(100);
    expect(tokens).toBeLessThan(150);
  });

  it("estimates images at flat rate", () => {
    const messages: Message[] = [
      {
        content: { data: new Uint8Array(100), mediaType: "image/webp", type: "image" },
        role: "user",
      },
    ];
    expect(estimateTokens(messages)).toBe(204);
  });

  it("counts message overhead per message", () => {
    const messages: Message[] = [
      { content: { content: "", type: "text" }, role: "user" },
      { content: { content: "", type: "text" }, role: "assistant" },
    ];
    expect(estimateTokens(messages)).toBe(8);
  });
});

describe("estimateSystemPrompt", () => {
  it("estimates based on length / 3", () => {
    const prompt = "a".repeat(300);
    expect(estimateSystemPrompt(prompt)).toBe(100);
  });
});


describe("applyReadSupersession", () => {
  it("keeps the latest read for each path", () => {
    const messages: Message[] = [
      {
        content: {
          id: "call-1",
          name: "read",
          output: { content: "old", path: "/workspace/file.txt", success: true },
          type: "toolResponse",
        },
        role: "toolResponse",
      },
      {
        content: {
          id: "call-2",
          name: "read",
          output: { content: "new", path: "/workspace/file.txt", success: true },
          type: "toolResponse",
        },
        role: "toolResponse",
      },
    ];

    const result = applyReadSupersession(messages);
    expect((result[0]!.content as { output: Record<string, unknown> }).output["superseded"]).toBe(true);
    expect((result[1]!.content as { output: Record<string, unknown> }).output["superseded"]).toBeUndefined();
  });

  it("does not affect different paths", () => {
    const messages: Message[] = [
      {
        content: {
          id: "call-1",
          name: "read",
          output: { content: "a", path: "/workspace/a.txt", success: true },
          type: "toolResponse",
        },
        role: "toolResponse",
      },
      {
        content: {
          id: "call-2",
          name: "read",
          output: { content: "b", path: "/workspace/b.txt", success: true },
          type: "toolResponse",
        },
        role: "toolResponse",
      },
    ];

    const result = applyReadSupersession(messages);
    expect((result[0]!.content as { output: Record<string, unknown> }).output["superseded"]).toBeUndefined();
    expect((result[1]!.content as { output: Record<string, unknown> }).output["superseded"]).toBeUndefined();
  });

  it("does not affect non-read tool responses", () => {
    const messages: Message[] = [
      {
        content: {
          id: "call-1",
          name: "exec",
          output: { stdout: "hello", success: true },
          type: "toolResponse",
        },
        role: "toolResponse",
      },
    ];

    const result = applyReadSupersession(messages);
    expect((result[0]!.content as { output: Record<string, unknown> }).output["superseded"]).toBeUndefined();
  });
});