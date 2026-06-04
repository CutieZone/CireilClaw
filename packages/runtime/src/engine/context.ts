import type { Message } from "./message.js";
import type { Tool } from "./tool.js";

interface Context {
  messages: Message[];
  systemPrompt: string;
  sessionId: string;
  cacheBreakpoints?: number[];
  tools: Tool[];
}

interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  systemPromptTokensEst: number;
}

export type { Context, UsageInfo };
