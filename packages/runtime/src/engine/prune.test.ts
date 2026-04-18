import { describe, expect, it } from "vitest";
import { applyReadSupersession, estimateSystemPrompt, estimateTokens, pruneToBudget } from "./prune.js";
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
    const [msg0, msg1] = result;
    if (msg0 === undefined) { throw new Error("Expected msg0"); }
    expect(msg0.content).toHaveProperty("output.superseded", true);
    if (msg1 === undefined) { throw new Error("Expected msg1"); }
    expect(msg1.content).not.toHaveProperty("output.superseded");
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
    const [msg0, msg1] = result;
    if (msg0 === undefined) { throw new Error("Expected msg0"); }
    expect(msg0.content).not.toHaveProperty("output.superseded");
    if (msg1 === undefined) { throw new Error("Expected msg1"); }
    expect(msg1.content).not.toHaveProperty("output.superseded");
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
    const [msg0] = result;
    if (msg0 === undefined) { throw new Error("Expected msg0"); }
    expect(msg0.content).not.toHaveProperty("output.superseded");
  });
});


describe("pruneToBudget", () => {
  it("returns all messages when under budget", () => {
    const messages: Message[] = [
      { content: { content: "Hello", type: "text" }, role: "user" },
      { content: { content: "Hi there", type: "text" }, role: "assistant" },
    ];
    const result = pruneToBudget(messages, 0, 100, 1000);
    expect(result.messages).toHaveLength(2);
  });

  it("evicts tool responses when over budget", () => {
    const longContent = "x".repeat(3000);
    const messages: Message[] = [
      { content: { content: "Hello", type: "text" }, role: "user" },
      {
        content: {
          id: "call-1",
          name: "read",
          output: { content: longContent, path: "/workspace/file.txt", success: true },
          type: "toolResponse",
        },
        role: "toolResponse",
      },
      { content: { content: "Thanks", type: "text" }, role: "user" },
      {
        content: {
          id: "call-2",
          name: "read",
          output: { content: longContent, path: "/workspace/file2.txt", success: true },
          type: "toolResponse",
        },
        role: "toolResponse",
      },
    ];

    const result = pruneToBudget(messages, 0, 100, 500);
    const firstTool = result.messages.find((msg) => {
      const content = Array.isArray(msg.content) ? msg.content[0] : msg.content;
      return content?.type === "toolResponse" && content.id === "call-1";
    });
    if (firstTool === undefined) {
      throw new Error("Expected firstTool to be defined");
    }
    expect(firstTool.content).toHaveProperty("output.superseded", true);
  });

  it("applies maxTurns as hard cap", () => {
    const messages: Message[] = [];
    for (let idx = 0; idx < 10; idx++) {
      messages.push({ content: { content: `Turn ${idx}`, type: "text" }, role: "user" });
      messages.push({ content: { content: `Reply ${idx}`, type: "text" }, role: "assistant" });
    }

    const result = pruneToBudget(messages, 0, 5, 1_000_000);
    const userCount = result.messages.filter((msg) => msg.role === "user").length;
    expect(userCount).toBeLessThanOrEqual(5);
  });
});
