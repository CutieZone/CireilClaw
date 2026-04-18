import { describe, expect, it } from "vitest";

import type { Message } from "./message.js";
import {
  applyReadSupersession,
  estimateSystemPrompt,
  estimateTokens,
  pruneHistory,
  pruneToBudget,
} from "./prune.js";

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
    if (msg0 === undefined) {
      throw new Error("Expected msg0");
    }
    expect(msg0.content).toHaveProperty("output.superseded", true);
    if (msg1 === undefined) {
      throw new Error("Expected msg1");
    }
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
    if (msg0 === undefined) {
      throw new Error("Expected msg0");
    }
    expect(msg0.content).not.toHaveProperty("output.superseded");
    if (msg1 === undefined) {
      throw new Error("Expected msg1");
    }
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
    if (msg0 === undefined) {
      throw new Error("Expected msg0");
    }
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
describe("pruneHistory", () => {
  it("supersedes stale reads without advancing cursor when under hard cap", () => {
    const history: Message[] = [
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
      { content: { content: "Hello", type: "text" }, role: "user" },
    ];

    const { modifiedHistory, newCursor, stats } = pruneHistory(
      history,
      0,
      100, // maxTurns
      10_000, // contextWindow
      0.6,
      0.85,
      0, // systemTokens
    );

    expect(newCursor).toBe(0);
    expect(stats).toBeUndefined();
    expect(modifiedHistory).toHaveLength(3);

    const [firstTool] = modifiedHistory;
    if (firstTool?.role !== "toolResponse") {
      throw new Error("Expected firstTool to be a toolResponse");
    }
    expect(firstTool.content).toHaveProperty("output.superseded", true);

    const [, secondTool] = modifiedHistory;
    if (secondTool?.role !== "toolResponse") {
      throw new Error("Expected secondTool to be a toolResponse");
    }

    // Original history is NOT mutated — we get a new array.
    expect(history[0]?.content).not.toHaveProperty("output.superseded");
  });

  it("advances cursor when hard cap is exceeded", () => {
    // Create messages that push us over a small hard cap.
    const longContent = "x".repeat(3000);
    const history: Message[] = [
      { content: { content: longContent, type: "text" }, role: "user" },
      { content: { content: longContent, type: "text" }, role: "assistant" },
      { content: { content: longContent, type: "text" }, role: "user" },
      { content: { content: longContent, type: "text" }, role: "assistant" },
      { content: { content: longContent, type: "text" }, role: "user" },
      { content: { content: longContent, type: "text" }, role: "assistant" },
    ];

    const contextWindow = 4000; // Large enough for 1 turn, small enough to prune 6
    const contextBudget = 0.6;
    const contextHardBudget = 0.85;
    const hardCap = Math.floor(contextWindow * contextHardBudget);
    const softBudget = Math.floor(contextWindow * contextBudget);

    const historyTokens = estimateTokens(history);
    expect(historyTokens).toBeGreaterThan(hardCap);

    const { modifiedHistory, newCursor, stats } = pruneHistory(
      history,
      0,
      100,
      contextWindow,
      contextBudget,
      contextHardBudget,
      0,
    );

    expect(stats).not.toBeUndefined();
    expect(newCursor).toBeGreaterThan(0);
    expect(modifiedHistory).toHaveLength(history.length);

    // Messages after the cursor are the pruned ones.
    const visible = modifiedHistory.slice(newCursor);
    const visibleTokens = estimateTokens(visible);
    expect(visibleTokens).toBeLessThanOrEqual(softBudget);
  });

  it("accumulates context between prunes (hysteresis)", () => {
    const longContent = "x".repeat(3000);
    const history: Message[] = [
      { content: { content: longContent, type: "text" }, role: "user" },
      { content: { content: longContent, type: "text" }, role: "assistant" },
    ];

    const contextWindow = 10_000;

    // First call — under hard cap, cursor stays at 0.
    const first = pruneHistory(history, 0, 100, contextWindow, 0.6, 0.85, 0);
    expect(first.newCursor).toBe(0);

    // Simulate adding more messages until we exceed the cap.
    const expandedHistory: Message[] = [
      ...history,
      { content: { content: longContent, type: "text" }, role: "user" },
      { content: { content: longContent, type: "text" }, role: "assistant" },
      { content: { content: longContent, type: "text" }, role: "user" },
      { content: { content: longContent, type: "text" }, role: "assistant" },
      { content: { content: longContent, type: "text" }, role: "user" },
      { content: { content: longContent, type: "text" }, role: "assistant" },
    ];

    // Use a tiny window so we're guaranteed over cap.
    const second = pruneHistory(expandedHistory, 0, 100, 100, 0.6, 0.85, 0);
    expect(second.newCursor).toBeGreaterThan(0);

    // Third call — now with the cursor already advanced, should be under cap
    // again and NOT advance further.
    const third = pruneHistory(second.modifiedHistory, second.newCursor, 100, 100, 0.6, 0.85, 0);
    expect(third.newCursor).toBe(second.newCursor);
  });

  it("persists superseded reads into full history on prune", () => {
    const history: Message[] = [
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
      { content: { content: "Hello", type: "text" }, role: "user" },
      { content: { content: "Hi", type: "text" }, role: "assistant" },
    ];

    // Tiny window to force pruning.
    const { modifiedHistory, newCursor } = pruneHistory(history, 0, 100, 100, 0.6, 0.85, 0);

    // Full history should still contain ALL messages.
    expect(modifiedHistory).toHaveLength(history.length);

    // The superseded read should be in the full history at its original index,
    // even if it's now before the cursor.
    const [firstTool] = modifiedHistory;
    if (firstTool?.role !== "toolResponse") {
      throw new Error("Expected firstTool");
    }
    expect(firstTool.content).toHaveProperty("output.superseded", true);

    // Visible messages start after cursor.
    const visible = modifiedHistory.slice(newCursor);
    expect(visible.length).toBeGreaterThan(0);
  });

  it("handles legacy maxTurns path correctly", () => {
    const history: Message[] = [];
    for (let idx = 0; idx < 10; idx++) {
      history.push({ content: { content: `Turn ${idx}`, type: "text" }, role: "user" });
      history.push({ content: { content: `Reply ${idx}`, type: "text" }, role: "assistant" });
    }

    const { modifiedHistory, newCursor } = pruneHistory(
      history,
      0,
      5, // maxTurns
      undefined, // no contextWindow
      0.6,
      0.85,
      0,
    );

    expect(newCursor).toBeGreaterThan(0);
    expect(modifiedHistory).toHaveLength(history.length);

    const visible = modifiedHistory.slice(newCursor);
    const userCount = visible.filter((msg) => msg.role === "user").length;
    expect(userCount).toBe(5);
  });

  it("does not lose messages when cursor is already advanced", () => {
    const history: Message[] = [
      { content: { content: "Old 1", type: "text" }, role: "user" },
      { content: { content: "Old 2", type: "text" }, role: "assistant" },
      { content: { content: "Current", type: "text" }, role: "user" },
    ];

    // Start with cursor at 2 (first two messages already pruned).
    const { modifiedHistory, newCursor } = pruneHistory(history, 2, 100, 10_000, 0.6, 0.85, 0);

    expect(newCursor).toBe(2); // Under cap, no change.
    expect(modifiedHistory).toHaveLength(3);
    expect(modifiedHistory[2]?.content).toEqual({ content: "Current", type: "text" });
  });
});
