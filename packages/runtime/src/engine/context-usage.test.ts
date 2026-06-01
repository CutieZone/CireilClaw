import { describe, expect, it } from "vitest";

import {
  computeContextUsageSnapshot,
  formatContextPruneWarning,
  formatContextUsage,
  formatPromptMetadata,
} from "./context-usage.js";
import type { Message } from "./message.js";

describe("computeContextUsageSnapshot", () => {
  it("computes context percentages and prune thresholds", () => {
    const messages: Message[] = [
      { content: { content: "x".repeat(1788), type: "text" }, role: "user" },
    ];

    const snapshot = computeContextUsageSnapshot({
      contextBudget: 0.6,
      contextHardBudget: 0.85,
      contextWindow: 1000,
      messages,
      systemTokens: 0,
    });

    expect(snapshot.estimatedTokens).toBe(600);
    expect(snapshot.softPruneTarget).toBe(600);
    expect(snapshot.hardPruneTrigger).toBe(850);
    expect(snapshot.usedPercent).toBe(60);
    expect(snapshot.hardPrunePercent).toBe(85);
    expect(snapshot.remainingToHardPrune).toBe(250);
    expect(snapshot.shouldWarnBeforePrune).toBe(false);
  });

  it("warns only while within five percent before hard pruning", () => {
    const messages: Message[] = [
      { content: { content: "x".repeat(2391), type: "text" }, role: "user" },
    ];

    const snapshot = computeContextUsageSnapshot({
      contextBudget: 0.6,
      contextHardBudget: 0.85,
      contextWindow: 1000,
      messages,
      systemTokens: 0,
    });

    expect(snapshot.estimatedTokens).toBe(801);
    expect(snapshot.remainingToHardPrune).toBe(49);
    expect(snapshot.shouldWarnBeforePrune).toBe(true);
  });

  it("does not warn after the hard prune trigger is exceeded", () => {
    const messages: Message[] = [
      { content: { content: "x".repeat(2538), type: "text" }, role: "user" },
    ];

    const snapshot = computeContextUsageSnapshot({
      contextBudget: 0.6,
      contextHardBudget: 0.85,
      contextWindow: 1000,
      messages,
      systemTokens: 0,
    });

    expect(snapshot.estimatedTokens).toBe(850);
    expect(snapshot.remainingToHardPrune).toBe(0);
    expect(snapshot.shouldWarnBeforePrune).toBe(false);
  });
});

describe("formatContextUsage", () => {
  it("formats percentage metadata when context window is available", () => {
    const snapshot = computeContextUsageSnapshot({
      contextBudget: 0.6,
      contextHardBudget: 0.85,
      contextWindow: 1000,
      messages: [{ content: { content: "x".repeat(288), type: "text" }, role: "user" }],
      systemTokens: 0,
    });

    expect(formatContextUsage(snapshot)).toBe(
      "Context usage: ~100 / 1000 tokens (10.0% of context window; auto-prune at 850 tokens / 85.0%; ~750 tokens remaining before auto-prune).",
    );
  });

  it("formats unavailable-window metadata without percentages", () => {
    const snapshot = computeContextUsageSnapshot({
      contextBudget: 0.6,
      contextHardBudget: 0.85,
      contextWindow: undefined,
      messages: [{ content: { content: "x".repeat(288), type: "text" }, role: "user" }],
      systemTokens: 0,
    });

    expect(formatContextUsage(snapshot)).toBe(
      "Context usage: ~100 tokens (context window unavailable; token-budget percentage unavailable; max-turn pruning applies).",
    );
  });

  it("formats prompt metadata next to the current date", () => {
    const snapshot = computeContextUsageSnapshot({
      contextBudget: 0.6,
      contextHardBudget: 0.85,
      contextWindow: undefined,
      messages: [],
      systemTokens: 1,
    });

    expect(formatPromptMetadata("2026-05-27", snapshot)).toBe(
      "Current date: 2026-05-27\nContext usage: ~1 tokens (context window unavailable; token-budget percentage unavailable; max-turn pruning applies).",
    );
  });
});

describe("formatContextPruneWarning", () => {
  it("includes remaining tokens and approximate prune target", () => {
    const snapshot = computeContextUsageSnapshot({
      contextBudget: 0.6,
      contextHardBudget: 0.85,
      contextWindow: 1000,
      messages: [{ content: { content: "x".repeat(2391), type: "text" }, role: "user" }],
      systemTokens: 0,
    });
    expect(formatContextPruneWarning(snapshot)).toBe(
      "Context note: the conversation window is approaching its limit (~49 tokens before auto-prune). When pruning happens, older turns will be dropped to keep roughly ~600 tokens. If anything in this conversation needs to survive, write it to a file now.",
    );
  });
  it("falls back to zero when fields are missing", () => {
    expect(formatContextPruneWarning({ estimatedTokens: 100, shouldWarnBeforePrune: false })).toBe(
      "Context note: the conversation window is approaching its limit (~0 tokens before auto-prune). When pruning happens, older turns will be dropped to keep roughly ~0 tokens. If anything in this conversation needs to survive, write it to a file now.",
    );
  });
});
