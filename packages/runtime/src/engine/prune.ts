import type { Message } from "$/engine/message.js";
import type { Content } from "./content.js";

export function truncateToTurns(messages: Message[], maxTurns: number): Message[] {
  const turns: Message[][] = [];

  for (const msg of messages) {
    // Start a new turn on user messages, or if we're just beginning
    if (msg.role === "user" || turns.length === 0) {
      turns.push([msg]);
    } else {
      // Associate with the current turn (assistant or toolResponse)
      const currentTurn = turns.at(-1);
      if (currentTurn !== undefined) {
        currentTurn.push(msg);
      }
    }
  }

  // Keep only the last maxTurns
  const truncated = turns.slice(-maxTurns);
  return truncated.flat();
}

export function squashMessages(messages: Message[]): Message[] {
  const result: Message[] = [];

  for (const msg of messages) {
    const last = result.at(-1);

    if (last?.role === "user" && msg.role === "user") {
      const prev = Array.isArray(last.content) ? last.content : [last.content];
      const cur = Array.isArray(msg.content) ? msg.content : [msg.content];
      result.splice(-1, 1, { content: [...prev, ...cur], role: "user" });
    } else if (last?.role === "assistant" && msg.role === "assistant") {
      const prev = Array.isArray(last.content) ? last.content : [last.content];
      const cur = Array.isArray(msg.content) ? msg.content : [msg.content];
      result.splice(-1, 1, { content: [...prev, ...cur], role: "assistant" });
    } else {
      result.push(msg);
    }
  }

  return result;
}


const CHARS_PER_TOKEN = 3;
const IMAGE_TOKEN_OVERHEAD = 200;
const MESSAGE_OVERHEAD = 4;

function estimateContentTokens(block: Content): number {
  switch (block.type) {
    case "text":
      return Math.ceil(block.content.length / CHARS_PER_TOKEN);
    case "toolCall":
      return Math.ceil(JSON.stringify(block.input).length / CHARS_PER_TOKEN);
    case "toolResponse":
      return Math.ceil(JSON.stringify(block.output).length / CHARS_PER_TOKEN);
    case "image":
    case "image_ref":
      return IMAGE_TOKEN_OVERHEAD;
    case "thinking":
      return Math.ceil(block.thinking.length / CHARS_PER_TOKEN);
    case "redacted_thinking":
      return Math.ceil(block.data.length / CHARS_PER_TOKEN);
    case "video":
    case "video_ref":
      return IMAGE_TOKEN_OVERHEAD;
    default: {
      void (block as never);
      return MESSAGE_OVERHEAD;
    }
  }
}

export function estimateTokens(messages: Message[]): number {
  let tokens = 0;
  for (const msg of messages) {
    tokens += MESSAGE_OVERHEAD;
    const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
    for (const block of blocks) {
      tokens += estimateContentTokens(block);
    }
  }
  return tokens;
}

export function estimateSystemPrompt(prompt: string): number {
  return Math.ceil(prompt.length / CHARS_PER_TOKEN);
}

export function applyReadSupersession(messages: Message[]): Message[] {
  const lastReadByPath = new Map<string, number>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "toolResponse" && msg.content.name === "read") {
      const output = msg.content.output as Record<string, unknown>;
      if (typeof output["path"] === "string") {
        lastReadByPath.set(output["path"], i);
      }
    }
  }

  return messages.map((msg, i) => {
    if (msg.role !== "toolResponse" || msg.content.name !== "read") {
      return msg;
    }
    const output = msg.content.output as Record<string, unknown>;
    if (typeof output["path"] !== "string") {
      return msg;
    }
    if (lastReadByPath.get(output["path"]) === i) {
      return msg;
    }

    return {
      ...msg,
      content: {
        ...msg.content,
        output: { path: output["path"], superseded: true },
      },
    };
  });
}