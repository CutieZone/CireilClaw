import type { Message } from "./message.js";
import type { Tool } from "./tool.js";

export interface Context {
  messages: Message[];
  systemPrompt: string;
  sessionId: string;
  tools?: Tool[];
}
