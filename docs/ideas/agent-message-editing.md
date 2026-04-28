# Agent Message Editing

## Problem

When an agent makes a mistake in a long task, verbal corrections in a follow-up message do not fix the flawed message already in `session.history`. The agent continues reasoning from the incorrect output, causing errors to compound. Currently there is no mechanism for a user to edit a past agent message — neither its Discord rendering nor its stored history entry.

## Constraints

- Discord bot messages cannot be edited by users natively; only the bot can edit its own messages.
- Agent responses are split into 1800-character chunks (`CHUNK_LIMIT`) before sending to Discord.
- Discord modal text inputs support up to 4000 characters — well above our chunk size.
- A single assistant turn can produce multiple Discord message chunks.
- `reply.sendTo` is currently `Promise<void>` — it cannot return chunk IDs to the caller.

## Proposed Design

### 1. Capture Chunk IDs and Full Text

The Discord `send()` handler currently discards the `DiscordMessage` objects returned by `createMessage`. It must capture the message ID from each chunk and return them to the caller.

The data flow spans four layers, all of which must change:

1. **Discord `send()`** — capture `createMessage` return values, return `chunkIds: string[]`.
2. **`reply.sendTo`** — change signature from `Promise<void>` to `Promise<string[]>` (returning chunk IDs).
3. **`respond` tool** — include chunk IDs in its return value.
4. **`ToolResponseContent.output`** — stores `chunkIds` and `fullText` (the original pre-split content).

`BaseMessage.id` stays `?: string` — it is a dedup key used by `handleMessageUpdate` and `handleMessageDelete` for exact string comparison against individual Discord message IDs, and should not be repurposed.

The tool response output shape:

```ts
// ToolResponseContent.output for respond calls:
{
  final: boolean;
  sent: true;
  chunkIds: string[];       // Discord message IDs, one per chunk
  fullText: string;          // original pre-split content
}
```

`fullText` is stored because `splitMessage` injects ` ``` ` fence closers/openers at chunk boundaries. Concatenating chunks would include these artifacts and produce text that differs from what the model generated. Storing the original avoids this loss.

### 2. Slash Command + Modal Flow

- `/edit <msgId>` — accepts a Discord message ID (a chunk).
- The bot fetches the chunk text from Discord and opens a modal pre-filled with it. The modal sets `max_length` to `CHUNK_LIMIT` (1800) directly — no separate server-side validation needed.
- The user edits and submits.
- On modal submit, the bot:
  1. Checks `session.busy` — if the agent is mid-turn, rejects with an error response.
  2. Checks that `msgId` belongs to a `persist: true` message. Ephemeral messages (`persist: false`, used for reply-chain context backfills) are not editable — reject with an error response.
  3. Updates the Discord message via REST.
  4. Finds the `ToolMessage` in `session.history` whose `output.chunkIds` contains `msgId`.
  5. Replaces `output.fullText` with the reconstructed text (edited chunk + untouched sibling chunks fetched from Discord).
  6. Calls `saveSession()`.
  7. If `saveSession()` fails, reverts the Discord edit via REST. If the revert also fails, logs the inconsistency and surfaces it to the user.

### 3. Mapping Chunks to History

Each `respond` tool call has a unique `id` (from the provider). The `ToolMessage` (tool response) references the same `id`. The tool response's `output` stores `chunkIds` and `fullText`:

```
AssistantMessage.content[i]   // ToolCallContent with id="call_abc"
  ↓ id="call_abc"
ToolMessage.content           // ToolResponseContent with output.chunkIds=["msg1","msg2"], output.fullText="..."
  ↓ chunkIds
Discord messages              // actual rendered chunks
```

To find the owning `ToolMessage` for a given chunk ID, scan `session.history` for messages where `role === "toolResponse"` and `output.chunkIds` includes the target ID. This is O(n) per edit but session histories are small enough that it is not a concern.

In practice, each assistant message contains at most one meaningful `respond(final: true)` call, so the mapping from chunks back to a single tool response is unambiguous.

### 4. No Re-chunking

Edits happen at the chunk level. We do not re-run `splitMessage()` or adjust chunk boundaries. The user edits what they see, and the change is reflected in both Discord and history. Since `fullText` is reconstructed from chunks after edit and stored directly, boundary drift is not a concern. The only validation needed is that the edited chunk fits within `CHUNK_LIMIT` — enforced by the modal's `max_length`.

### 5. Cross-Channel Sends

When the agent uses `channel: "owner"`, `"last"`, or an explicit session ID, the respond tool calls `reply.sendTo(targetSession, content)`. The chunk IDs land in a **different** session's Discord channel.

- **Chunk tracking**: `sendTo` returns chunk IDs to the respond tool. The respond tool stores them in the **current** session's tool response output. Additionally, if the target session is owned by the same agent, the chunk IDs are also stored on the target session's history (via a separate `ToolMessage` appended to that session).
- **Editing**: `/edit` on the current session only finds chunks from the current session's tool responses. Cross-channel chunks are not editable via the current session's `/edit` — the user must switch to the target channel and use `/edit` there if that channel is also owned by the same bot.

### 6. Suppressing `handleMessageUpdate` for Self-Triggered Edits

When `/edit` updates a Discord chunk via REST, Discord fires a `messageUpdate` event. The existing `handleMessageUpdate` handler would catch this and reformat the history entry (wrapping it in `<assistant-context>` tags), overwriting the mutation that `/edit` just applied.

To prevent this: in `handleMessageUpdate`, before processing, check whether `msg.id` appears in any `ToolResponseContent.output.chunkIds` array in the session's history. If it does, skip — the edit handler has already updated history for this message. If it does not, proceed with the existing reformatting logic.

### 7. Undo Mechanism

Two commands:

- `/undo edit` — restores the previous version of an edited message. Requires storing edit history per message (previous `fullText` and per-chunk text).
- `/undo turn` — rolls back the entire last turn (all assistant messages + tool responses added in that turn). Requires a confirmation step because this is destructive.

Native Discord message history is not sufficient because it does not restore the agent's `session.history` state.

Passive update (mutate history, move on) is the **default** for all edits. Active re-run for `/undo turn` (re-invoke the engine from the rollback point) is a **possible future enhancement** — not in scope for the initial implementation.

## Implementation Sketch

- `packages/runtime/src/engine/content.ts` — add `chunkIds: string[]` and `fullText: string` to the respond tool's output type (in practice, these live in the untyped `output: unknown` field of `ToolResponseContent` — no schema change needed at this layer).
- `packages/runtime/src/engine/tools/respond.ts` — return `chunkIds` and `fullText` from `execute()`.
- `packages/runtime/src/engine/tool-def.ts` — change `reply.sendTo` return type from `Promise<void>` to `Promise<string[]>`.
- `packages/runtime/src/engine/index.ts` — propagate the new `sendTo` signature in `runTurn`.
- `packages/runtime/src/channels/discord.ts`:
  - Update `send()` to capture `createMessage` return values and return chunk IDs.
  - Add chunk-ID check in `handleMessageUpdate` to skip self-triggered edits.
  - Add `InteractionTypes.MODAL_SUBMIT` branch to `handleInteractionCreate`.
- `packages/runtime/src/channels/discord/edit-command.ts` — slash command definition, modal creation, and submit handler with the atomicity protocol.
- `packages/runtime/src/harness/channel-handler.ts` — update `ChannelHandler.send` / `sendTo` return types.
- DB migration: not required. The new fields (`chunkIds`, `fullText`) live inside `output: unknown` of `ToolResponseContent`, which is JSON-serialized as-is. No schema change.

## TUI Parity

The same history structure can support message editing in the TUI channel via a keybind or command, even though the TUI has no native message editing UI today. Since the TUI has no chunking, the TUI's `send()` would return a single-element `chunkIds` array (using a synthetic ID).

## Open Questions — Answered

1. **TUI editing by turn index?**
   - In TUI, only the latest message should be editable. Turn index selection is unnecessary complexity for a terminal interface.

2. **Editing tool-call arguments other than `respond.content`?**
   - Nope. Out of scope. Only the rendered text from `respond` calls is editable.

3. **Undo mechanism?**
   - Yes. Covered in section 7 above.

4. **Passive update vs. active re-run?**
   - Passive update is the **default** — mutate history and move on.
   - Active re-run for `/undo turn` is a **possible future enhancement** — not in scope for the initial implementation.

## References

- Discord modal components: https://docs.discord.com/developers/components/using-modal-components
- Discord component reference: https://docs.discord.com/developers/components/reference
- Current chunking logic: `packages/runtime/src/channels/discord.ts` (`splitMessage`, `CHUNK_LIMIT`)
- Current message types: `packages/runtime/src/engine/message.ts`
- Current content types: `packages/runtime/src/engine/content.ts`
- Current turn loop: `packages/runtime/src/engine/index.ts`
- Existing slash commands: `packages/runtime/src/channels/discord/{clear,model,repair}-command.ts`
- Existing message update/delete handlers: `packages/runtime/src/channels/discord.ts` (`handleMessageUpdate`, `handleMessageDelete`)
- Migration that added assistant message IDs: `packages/runtime/src/config/migrations/20260322000000_assistant_message_ids/`
- Channel handler interface: `packages/runtime/src/harness/channel-handler.ts`
- Tool definitions: `packages/runtime/src/engine/tools/tool-def.ts`
- Respond tool: `packages/runtime/src/engine/tools/respond.ts`

## Status

Not implemented. Requires:

1. Changing `reply.sendTo` return type from `void` to `string[]`.
2. Capturing chunk IDs in Discord `send()`.
3. Returning `chunkIds` + `fullText` from the respond tool.
4. Adding `/edit` slash command with modal flow and atomicity protocol.
5. Adding chunk-ID guard to `handleMessageUpdate`.
6. Adding `persist: false` and `session.busy` rejection in the edit handler.
7. Adding corresponding TUI command/keybind.
8. Tests for chunk ID tracking, history mutation, modal validation, and `handleMessageUpdate` suppression.

---

_Date: 2026-04-28_

- Discussed in conversation about maintaining coherence in long tasks vs. verbal corrections.
- Key insight: users cannot natively edit bot messages, so a slash-command + modal flow is the natural Discord-native approach.
- Key decision: edit at the chunk level without re-chunking; use `toolCall.id` as the join key between history and Discord chunks.
- Key simplification: each assistant message typically contains one meaningful `respond` call, making the mapping from chunks back to history straightforward.
- Key decision: chunk IDs and fullText live on ToolResponseContent.output, not on BaseMessage.id. BaseMessage.id stays string for dedup.
- Key decision: store fullText alongside chunkIds to avoid lossy reconstruction from concatenated chunks (splitMessage injects fence markers).
- Key decision: cross-channel sends store chunk IDs in the current session's history; editing cross-channel chunks requires using /edit in the target channel.
- Key decision: handleMessageUpdate skips messages whose ID appears in any toolResponse.output.chunkIds — preventing reformatting of self-triggered edits.
- Key decision: persist:false messages are not editable (ephemeral reply-chain backfills).
- Key decision: atomicity via Discord-first update, then history write, with Discord revert on history failure. Best-effort revert with logged inconsistency.
- TUI: the TUI bridge is one-way push today; editing would need bidirectional support or a command-based approach.
- Re-running turns: out of scope for this design; this is purely a history-correction mechanism, not a turn-replay mechanism.
- Chunk boundaries: since we store fullText and don't re-chunk, boundary drift is not a concern. The only validation needed is chunk-level CHUNK_LIMIT enforced by the modal.
- Tool calls: this design only supports editing the `content` argument of a `respond` tool call. Editing tool calls themselves (e.g. changing an `exec` command) is not supported and would require a different UI.
- Multiple responds per turn: while the engine technically allows multiple `respond` calls in one turn, in practice the model will not do this because it cannot see tool results mid-generation. Each `respond(final: true)` effectively lives in its own assistant message.
- Message IDs: the existing `20260322000000_assistant_message_ids` migration added IDs to assistant messages from `<assistant-context>` tags. The new chunk ID system is separate — `BaseMessage.id` remains unchanged for dedup. The `msgId` attribute on `<assistant-context>` tags is unaffected.
- Modal limits: Discord modal text inputs support `max_length: 4000`. Set `max_length: CHUNK_LIMIT` (1800) directly on the modal component — no separate server-side validation needed.
- Slash command options: the `/edit` command could accept the message ID as a required string option. Alternatively, a button component could be attached to each chunk message with a `custom_id` containing the chunk ID, avoiding the need for the user to copy-paste message IDs.
- Button approach: attaching an "Edit" button to every bot message is noisy. A better UX might be a context-menu command (right-click the message → "Edit agent message"), but Discord's context-menu command API is separate from chat-input commands and may not be supported by oceanic.js.
- Oceanic.js modal API: `interaction.createModal()` takes a payload with `type: 9` (MODAL), `custom_id`, `title`, and `components` (text inputs wrapped in labels). The submit is received as `InteractionTypes.MODAL_SUBMIT` with `interaction.data.custom_id` and `interaction.data.components` containing the input values.
- History format: assistant messages in history use `<assistant-context msgId="...">` tags in their text content. These are unaffected by chunk-level editing — the edit mutates `ToolResponseContent.output.fullText`, not the assistant message's content blocks.
- `saveSession`: after mutating `session.history`, `saveSession(agentSlug, session)` must be called. This is already done in `handleMessageUpdate` and `handleMessageDelete`.
- Concurrency: if the agent is mid-turn (`session.busy`), the edit is rejected with an error response. No queuing — the user can retry after the turn completes.
- Permissions: only the bot owner should be able to edit agent messages. The existing `ctx.ownerId` check in `handleInteractionCreate` can be reused.
- Error handling: the Discord REST edit and history mutation use a Discord-first approach. If the history write fails, the Discord edit is reverted. If the revert also fails, the inconsistency is logged and surfaced to the user. Full atomicity is not achievable without distributed transactions.
- Tests: unit tests should cover (a) chunk ID tracking in `send()`, (b) history mutation correctness (finding the right ToolMessage, updating fullText), (c) modal validation (too-long input rejected by modal's max_length), (d) handleMessageUpdate suppression when msg.id is a known chunk ID, (e) persist:false and busy rejection, (f) cross-channel chunk routing.
