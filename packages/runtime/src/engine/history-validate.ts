import type { Message } from "#engine/message.js";

import type { ToolCallContent } from "./content.js";

/**
 * Extract tool_call IDs from an assistant message.
 * Returns an empty array for non-assistant messages or messages without tool calls.
 */
function getToolCallIds(msg: Message): string[] {
  if (msg.role !== "assistant") {
    return [];
  }
  const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
  return blocks
    .filter((block): block is ToolCallContent => block.type === "toolCall")
    .map((block) => block.id);
}

/**
 * Validate and repair a message history for API invariants.
 *
 * Removes:
 * - `toolResponse` messages whose `content.id` is not found in any preceding
 *   (or subsequent) assistant message's `toolCall` blocks.
 * - `toolCall` blocks from assistant messages that have no matching
 *   `toolResponse` (keeps other content blocks).
 * - Assistant messages that become empty after stripping orphaned `toolCall`
 *   blocks.
 */
function validateHistory(history: Message[]): Message[] {
  // Pass 1: Collect all tool_call_ids from all assistant messages.
  const allToolCallIds = new Set<string>();
  for (const msg of history) {
    for (const id of getToolCallIds(msg)) {
      allToolCallIds.add(id);
    }
  }

  // Pass 2: Remove orphaned toolResponses (whose id doesn't match any tool_call).
  const filtered: Message[] = [];
  for (const msg of history) {
    if (msg.role === "toolResponse" && !allToolCallIds.has(msg.content.id)) {
      continue;
    }
    filtered.push(msg);
  }

  // Pass 3: Collect all tool_call_ids that have a matching toolResponse.
  const respondedIds = new Set<string>();
  for (const msg of filtered) {
    if (msg.role === "toolResponse") {
      respondedIds.add(msg.content.id);
    }
  }

  // Pass 4: Strip orphaned toolCall blocks from assistant messages.
  const result: Message[] = [];
  for (const msg of filtered) {
    if (msg.role !== "assistant") {
      result.push(msg);
      continue;
    }
    const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
    const kept = blocks.filter((block) => block.type !== "toolCall" || respondedIds.has(block.id));
    if (kept.length === 0) {
      // Assistant message became empty — drop it entirely.
      continue;
    }
    const single = kept.length === 1 ? kept[0] : undefined;
    if (single === undefined) {
      result.push({ ...msg, content: kept });
    } else {
      result.push({ ...msg, content: single });
    }
  }

  return result;
}

/**
 * After a message has been removed from an in-memory history array, scan
 * forward from `fromIndex` and remove any `toolResponse` messages whose
 * `content.id` matches one of the `removedToolCallIds`.
 *
 * Mutates `history` in place (splice). Returns the number of cascaded
 * removals so the caller can adjust cursors.
 */
function cascadeRemoveToolResponses(
  history: Message[],
  removedToolCallIds: string[],
  fromIndex: number,
): number {
  if (removedToolCallIds.length === 0) {
    return 0;
  }
  const idSet = new Set(removedToolCallIds);
  let removed = 0;
  for (let idx = fromIndex; idx < history.length; ) {
    const msg = history[idx];
    if (msg?.role === "toolResponse" && idSet.has(msg.content.id)) {
      history.splice(idx, 1);
      removed++;
    } else {
      idx++;
    }
  }
  return removed;
}

export { cascadeRemoveToolResponses, getToolCallIds, validateHistory };
