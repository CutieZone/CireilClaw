import { describe, expect, it } from "vitest";
import { estimateSystemPrompt, estimateTokens } from "./prune.js";
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
