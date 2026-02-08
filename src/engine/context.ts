import type { Message } from "./message.js";

export interface Context {
  messages: Message[];
  systemPrompt: string;
  sessionId: string;
}
