import type { Message } from "#engine/message.js";

import { estimateTokens } from "./prune.js";

const WARNING_REMAINING_RATIO = 0.05;

interface ContextUsageSnapshot {
  estimatedTokens: number;
  contextWindow?: number;
  softPruneTarget?: number;
  hardPruneTrigger?: number;
  usedPercent?: number;
  hardPrunePercent?: number;
  remainingToHardPrune?: number;
  shouldWarnBeforePrune: boolean;
}

interface ContextUsageInput {
  messages: Message[];
  systemTokens: number;
  contextWindow: number | undefined;
  contextBudget: number;
  contextHardBudget: number;
}

function computeContextUsageSnapshot(input: ContextUsageInput): ContextUsageSnapshot {
  const estimatedTokens = input.systemTokens + estimateTokens(input.messages);
  const { contextWindow } = input;

  if (contextWindow === undefined) {
    return {
      estimatedTokens,
      shouldWarnBeforePrune: false,
    };
  }

  const softPruneTarget = Math.floor(contextWindow * input.contextBudget);
  const hardPruneTrigger = Math.floor(contextWindow * input.contextHardBudget);
  const remainingToHardPrune = hardPruneTrigger - estimatedTokens;

  return {
    contextWindow,
    estimatedTokens,
    hardPrunePercent: (hardPruneTrigger / contextWindow) * 100,
    hardPruneTrigger,
    remainingToHardPrune,
    shouldWarnBeforePrune:
      remainingToHardPrune > 0 &&
      remainingToHardPrune <= Math.floor(contextWindow * WARNING_REMAINING_RATIO),
    softPruneTarget,
    usedPercent: (estimatedTokens / contextWindow) * 100,
  };
}

function formatPercent(percent: number): string {
  return percent.toFixed(1);
}

function formatContextUsage(snapshot: ContextUsageSnapshot): string {
  if (snapshot.contextWindow === undefined) {
    return `Context usage: ~${snapshot.estimatedTokens} tokens (context window unavailable; token-budget percentage unavailable; max-turn pruning applies).`;
  }

  return `Context usage: ~${snapshot.estimatedTokens} / ${snapshot.contextWindow} tokens (${formatPercent(snapshot.usedPercent ?? 0)}% of context window; auto-prune at ${snapshot.hardPruneTrigger ?? 0} tokens / ${formatPercent(snapshot.hardPrunePercent ?? 0)}%; ~${snapshot.remainingToHardPrune ?? 0} tokens remaining before auto-prune).`;
}

function formatPromptMetadata(currentDate: string, snapshot: ContextUsageSnapshot): string {
  return `Current date: ${currentDate}\n${formatContextUsage(snapshot)}`;
}

function formatContextPruneWarning(snapshot: ContextUsageSnapshot): string {
  const remaining = snapshot.remainingToHardPrune ?? 0;
  const target = snapshot.softPruneTarget ?? 0;
  return `Context note: the conversation window is approaching its limit (~${remaining} tokens before auto-prune). When pruning happens, older turns will be dropped to keep roughly ~${target} tokens. If anything in this conversation needs to survive, write it to a file now.`;
}

export {
  formatContextPruneWarning,
  computeContextUsageSnapshot,
  formatContextUsage,
  formatPromptMetadata,
  type ContextUsageInput,
  type ContextUsageSnapshot,
};
