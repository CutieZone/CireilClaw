import type { Message } from "./message.js";
import type { Tool } from "./tool.js";

interface Context {
  messages: Message[];
  systemPrompt: string;
  sessionId: string;
  tools: Tool[];
}

interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  /** Estimated system prompt token count (length / 4 heuristic). */
  systemPromptTokensEst: number;
}

export type { Context, UsageInfo };
