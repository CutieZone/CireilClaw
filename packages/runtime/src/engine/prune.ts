import type { Message } from "$/engine/message.js";

import type { Content } from "./content.js";

function truncateToTurns(messages: Message[], maxTurns: number): Message[] {
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

function squashMessages(messages: Message[]): Message[] {
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
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}

function estimateTokens(messages: Message[]): number {
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

function estimateSystemPrompt(prompt: string): number {
  return Math.ceil(prompt.length / CHARS_PER_TOKEN);
}

function isRecord(obj: unknown): obj is Record<string, unknown> {
  return typeof obj === "object" && obj !== null;
}

function applyReadSupersession(messages: Message[]): Message[] {
  const lastReadByPath = new Map<string, number>();

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];
    if (msg === undefined) {
      continue;
    }
    if (
      msg.role === "toolResponse" &&
      msg.content.name === "read" &&
      isRecord(msg.content.output) &&
      typeof msg.content.output["path"] === "string"
    ) {
      lastReadByPath.set(msg.content.output["path"], idx);
    }
  }

  return messages.map((msg, idx) => {
    if (msg.role !== "toolResponse" || msg.content.name !== "read") {
      return msg;
    }
    if (!isRecord(msg.content.output)) {
      return msg;
    }
    if (typeof msg.content.output["path"] !== "string") {
      return msg;
    }
    if (lastReadByPath.get(msg.content.output["path"]) === idx) {
      return msg;
    }

    return {
      ...msg,
      content: {
        ...msg.content,
        output: { path: msg.content.output["path"], superseded: true },
      },
    };
  });
}

function evictToolResponses(messages: Message[], budget: number): Message[] {
  const evictable = new Set([
    "read",
    "exec",
    "list-dir",
    "brave-search",
    "session-info",
    "query-sessions",
    "list-sessions",
    "read-session",
    "read-history",
    "read-skill",
    "download-attachments",
    "schedule",
    "react",
    "open-file",
    "close-file",
    "str-replace",
  ]);

  let currentTokens = estimateTokens(messages);
  const result = [...messages];

  for (let idx = 0; idx < result.length && currentTokens > budget; idx++) {
    const msg = result[idx];
    if (!msg) {
      continue;
    }
    if (msg.role !== "toolResponse") {
      continue;
    }
    if (!evictable.has(msg.content.name)) {
      continue;
    }

    const oldTokens = estimateTokens([msg]);
    result[idx] = {
      ...msg,
      content: {
        ...msg.content,
        output: { reason: "budget", superseded: true, tool: msg.content.name },
      },
    };
    const newTokens = estimateTokens([result[idx] ?? msg]);
    currentTokens -= oldTokens - newTokens;
  }

  return result;
}

function truncateToBudget(messages: Message[], budget: number): Message[] {
  const turns: Message[][] = [];

  for (const msg of messages) {
    if (msg.role === "user" || turns.length === 0) {
      turns.push([msg]);
    } else {
      const currentTurn = turns.at(-1);
      if (currentTurn !== undefined) {
        currentTurn.push(msg);
      }
    }
  }

  while (turns.length > 1) {
    const flat = turns.flat();
    if (estimateTokens(flat) <= budget) {
      break;
    }
    turns.shift();
  }

  return turns.flat();
}

interface PruneResult {
  messages: Message[];
  stats: {
    finalTokens: number;
    messagesDropped: number;
    originalTokens: number;
    readSuperseded: number;
    toolResponsesEvicted: number;
    turnsDropped: number;
  };
}

function countTurns(messages: Message[]): number {
  let turns = 0;
  for (const msg of messages) {
    if (msg.role === "user") {
      turns++;
    }
  }
  return turns || 1;
}

function pruneToBudget(
  messages: Message[],
  systemTokens: number,
  maxTurns: number,
  budget: number,
): PruneResult {
  const originalTokens = estimateTokens(messages);

  // Step 1: Supersede stale reads
  let pruned = applyReadSupersession([...messages]);
  const readSuperseded = pruned.filter(
    (msg) =>
      msg.role === "toolResponse" &&
      msg.content.name === "read" &&
      isRecord(msg.content.output) &&
      msg.content.output["superseded"] === true,
  ).length;

  // Step 2: Evict oldest tool responses
  const historyBudget = budget - systemTokens;
  pruned = evictToolResponses(pruned, historyBudget);
  const toolResponsesEvicted = pruned.filter(
    (msg) =>
      msg.role === "toolResponse" &&
      isRecord(msg.content.output) &&
      msg.content.output["reason"] === "budget",
  ).length;

  // Step 3: Drop turns if still over budget
  let turnsDropped = 0;
  let messagesDropped = 0;
  if (estimateTokens(pruned) > historyBudget) {
    const beforeTurns = countTurns(pruned);
    const beforeLen = pruned.length;
    pruned = truncateToBudget(pruned, historyBudget);
    turnsDropped = beforeTurns - countTurns(pruned);
    messagesDropped += beforeLen - pruned.length;
  }

  // Step 4: Hard turn cap
  const beforeCap = countTurns(pruned);
  const beforeCapLen = pruned.length;
  pruned = truncateToTurns(pruned, maxTurns);
  const capDropped = beforeCap - countTurns(pruned);
  if (turnsDropped === 0) {
    turnsDropped = capDropped;
  } else {
    turnsDropped += capDropped;
  }
  messagesDropped += beforeCapLen - pruned.length;

  return {
    messages: pruned,
    stats: {
      finalTokens: estimateTokens(pruned),
      messagesDropped,
      originalTokens,
      readSuperseded,
      toolResponsesEvicted,
      turnsDropped,
    },
  };
}
interface PruneHistoryResult {
  modifiedHistory: Message[];
  newCursor: number;
  stats: PruneResult["stats"] | undefined;
}

/**
 * Cursor-based pruning with hysteresis.
 *
 * - `history` is the FULL conversation (never truncated).
 * - `cursor` is the index into `history`; messages from this index onward are
 *   what gets sent to the LLM.
 * - When under the hard cap, stale reads are superseded but the cursor stays
 *   put, letting context accumulate for cache stability.
 * - When over the hard cap, turns are dropped from the front of the visible
 *   slice and the cursor advances by `messagesDropped`.
 *
 * Returns a NEW history array with modifications (superseded reads, evicted
 * tools) applied, plus the updated cursor.
 */
function pruneHistory(
  history: Message[],
  cursor: number,
  maxTurns: number,
  contextWindow: number | undefined,
  contextBudget: number,
  contextHardBudget: number,
  systemTokens: number,
): PruneHistoryResult {
  if (contextWindow === undefined) {
    // Legacy path: hard turn cap only.
    const visible = history.slice(cursor);
    const pruned = truncateToTurns(visible, maxTurns);
    const messagesDropped = visible.length - pruned.length;
    const modifiedHistory = [...history];
    for (let idx = 0; idx < pruned.length; idx++) {
      const msg = pruned[idx];
      if (msg !== undefined) {
        modifiedHistory[cursor + messagesDropped + idx] = msg;
      }
    }
    return {
      modifiedHistory,
      newCursor: cursor + messagesDropped,
      stats: undefined,
    };
  }

  const softBudget = Math.floor(contextWindow * contextBudget);
  const hardCap = Math.floor(contextWindow * contextHardBudget);
  const visible = history.slice(cursor);
  const historyTokens = estimateTokens(visible);

  if (historyTokens + systemTokens > hardCap) {
    const { messages: pruned, stats } = pruneToBudget(
      visible,
      systemTokens,
      Number.MAX_SAFE_INTEGER,
      softBudget,
    );

    // Persist modifications (superseded reads, evicted tools) back into
    // full history. pruned[0] aligns with visible[stats.messagesDropped].
    const modifiedHistory = [...history];
    for (let idx = 0; idx < pruned.length; idx++) {
      const historyIdx = cursor + stats.messagesDropped + idx;
      const msg = pruned[idx];
      if (historyIdx < modifiedHistory.length && msg !== undefined) {
        modifiedHistory[historyIdx] = msg;
      }
    }
    return {
      modifiedHistory,
      newCursor: cursor + stats.messagesDropped,
      stats,
    };
  }

  // Under hard cap: still supersede stale reads for correctness, but
  // leave everything else intact so context can accumulate for caching.
  const modified = applyReadSupersession([...visible]);
  const modifiedHistory = [...history];
  for (let idx = 0; idx < modified.length; idx++) {
    const historyIdx = cursor + idx;
    const msg = modified[idx];
    if (historyIdx < modifiedHistory.length && msg !== undefined) {
      modifiedHistory[historyIdx] = msg;
    }
  }
  return {
    modifiedHistory,
    newCursor: cursor,
    stats: undefined,
  };
}

export {
  applyReadSupersession,
  estimateSystemPrompt,
  estimateTokens,
  pruneHistory,
  pruneToBudget,
  squashMessages,
  truncateToTurns,
  type PruneResult,
  type PruneHistoryResult,
};
