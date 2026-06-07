import { describe, expect, it } from "vitest";

import type { ToolCallContent } from "./content.js";
import { cascadeRemoveToolResponses, getToolCallIds, validateHistory } from "./history-validate.js";
import type { Message } from "./message.js";

function assistantMsg(content: string, ids?: string[]): Message {
  const toolCalls: ToolCallContent[] = ids
    ? ids.map((id) => ({ id, input: {}, name: "test", type: "toolCall" }))
    : [];
  const blocks = toolCalls.length > 0 ? toolCalls : [{ content, type: "text" as const }];
  const msg: Message = { content: blocks, role: "assistant" };
  return msg;
}

function toolResponse(id: string): Message {
  const msg: Message = {
    content: { id, name: "test", output: { ok: true }, type: "toolResponse" as const },
    role: "toolResponse",
  };
  return msg;
}

function userMsg(content: string): Message {
  const msg: Message = { content: { content, type: "text" as const }, role: "user" };
  return msg;
}

function systemMsg(content: string): Message {
  const msg: Message = { content: { content, type: "text" as const }, role: "system" };
  return msg;
}

describe("getToolCallIds", () => {
  it("returns ids from assistant message with tool calls", () => {
    const msg = assistantMsg("", ["call-1", "call-2"]);
    expect(getToolCallIds(msg)).toEqual(["call-1", "call-2"]);
  });

  it("returns empty for assistant message without tool calls", () => {
    const msg = assistantMsg("hello");
    expect(getToolCallIds(msg)).toEqual([]);
  });

  it("returns empty for user message", () => {
    const msg = userMsg("hi");
    expect(getToolCallIds(msg)).toEqual([]);
  });

  it("returns empty for tool response message", () => {
    const msg = toolResponse("call-1");
    expect(getToolCallIds(msg)).toEqual([]);
  });
});

describe("validateHistory", () => {
  it("leaves well-formed history unchanged", () => {
    const history: Message[] = [
      userMsg("what is the weather"),
      assistantMsg("", ["call-1"]),
      toolResponse("call-1"),
      assistantMsg("it is sunny"),
    ];
    const result = validateHistory(history);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual(history[0]);
    // assistant toolCall normalized from array to single object
    expect(result[1]).toEqual({
      content: { id: "call-1", input: {}, name: "test", type: "toolCall" },
      role: "assistant",
    });
    expect(result[2]).toEqual(history[2]);
    // assistant text normalized from array to single object
    expect(result[3]).toEqual({
      content: { content: "it is sunny", type: "text" },
      role: "assistant",
    });
  });

  it("removes orphaned tool response (no matching assistant)", () => {
    const messages: Message[] = [userMsg("hi"), toolResponse("call-orphan"), assistantMsg("hello")];
    const result = validateHistory(messages);
    expect(result).toHaveLength(2);
    expect(result[1]?.role).toBe("assistant");
  });

  it("strips orphaned toolCall block from assistant", () => {
    const msg: Message = {
      content: [
        { content: "Let me check", type: "text" },
        { id: "call-missing", input: {}, name: "read", type: "toolCall" },
      ],
      role: "assistant",
    };
    const messages: Message[] = [userMsg("find it"), msg];
    const result = validateHistory(messages);
    expect(result).toHaveLength(2);
    const [, assistant] = result;
    if (assistant === undefined) {
      throw new Error("Expected result[1]");
    }
    expect(assistant.role).toBe("assistant");
    const blocks = Array.isArray(assistant.content) ? assistant.content : [assistant.content];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("text");
  });

  it("removes assistant message that becomes empty after stripping", () => {
    const messages: Message[] = [
      userMsg("run tool"),
      {
        content: [{ id: "call-only", input: {}, name: "exec", type: "toolCall" }],
        role: "assistant",
      },
    ];
    const result = validateHistory(messages);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("user");
  });

  it("handles both orphan types simultaneously", () => {
    const messages: Message[] = [
      userMsg("a"),
      {
        content: [{ id: "call-orphan", input: {}, name: "exec", type: "toolCall" }],
        role: "assistant",
      },
      toolResponse("call-orphan"),
      toolResponse("call-nonexistent"),
      userMsg("b"),
    ];
    const result = validateHistory(messages);
    // toolResponse("call-nonexistent") removed; assistant with "call-orphan" stays
    expect(result).toHaveLength(4);
    expect(result[0]?.role).toBe("user");
    expect(result[3]?.role).toBe("user");
  });

  it("removes orphaned toolResponse and orphan toolCall when no match", () => {
    const messages: Message[] = [
      userMsg("a"),
      {
        content: [{ id: "call-orphan", input: {}, name: "exec", type: "toolCall" }],
        role: "assistant",
      },
      toolResponse("call-nonexistent"),
      userMsg("b"),
    ];
    const result = validateHistory(messages);
    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe("user");
    expect(result[1]?.role).toBe("user");
  });

  it("preserves toolCall with matching toolResponse", () => {
    const messages: Message[] = [
      userMsg("check"),
      assistantMsg("", ["call-ok"]),
      toolResponse("call-ok"),
    ];
    const result = validateHistory(messages);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual({
      content: { id: "call-ok", input: {}, name: "test", type: "toolCall" },
      role: "assistant",
    });
    expect(result[2]).toEqual(messages[2]);
  });

  it("preserves toolCall among mixed blocks when response exists", () => {
    const msg: Message = {
      content: [
        { content: "thinking...", type: "text" },
        { id: "call-ok", input: {}, name: "read", type: "toolCall" },
      ],
      role: "assistant",
    };
    const messages: Message[] = [userMsg("go"), msg, toolResponse("call-ok")];
    expect(validateHistory(messages)).toEqual(messages);
  });

  it("handles multiple toolCalls — some responded, some orphaned", () => {
    const messages: Message[] = [
      userMsg("multi"),
      {
        content: [
          { id: "call-1", input: {}, name: "read", type: "toolCall" },
          { id: "call-2", input: {}, name: "exec", type: "toolCall" },
          { id: "call-3", input: {}, name: "search", type: "toolCall" },
        ],
        role: "assistant",
      },
      toolResponse("call-1"),
      toolResponse("call-3"),
    ];
    const result = validateHistory(messages);
    expect(result).toHaveLength(4);
    const [, assistant] = result;
    if (assistant === undefined) {
      throw new Error("Expected result[1]");
    }
    const blocks = Array.isArray(assistant.content) ? assistant.content : [assistant.content];
    const callIds = blocks
      .filter((block) => block.type === "toolCall")
      .map((block) => (block as { id: string }).id);
    expect(callIds).toEqual(["call-1", "call-3"]);
  });

  it("leaves non-tool messages untouched", () => {
    const messages: Message[] = [userMsg("hello"), systemMsg("system note"), assistantMsg("world")];
    const result = validateHistory(messages);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[1]);
    // assistant text normalized from array to single object
    expect(result[2]).toEqual({
      content: { content: "world", type: "text" },
      role: "assistant",
    });
  });
});

describe("cascadeRemoveToolResponses", () => {
  it("removes toolResponses matching removed tool call ids", () => {
    const messages: Message[] = [
      userMsg("a"),
      assistantMsg("", ["call-1"]),
      toolResponse("call-1"),
      userMsg("b"),
    ];
    const removed = cascadeRemoveToolResponses(messages, ["call-1"], 1);
    expect(removed).toBe(1);
    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe("user");
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[2]?.role).toBe("user");
  });

  it("removes no toolResponses when no ids match", () => {
    const messages: Message[] = [
      userMsg("a"),
      assistantMsg("", ["call-1"]),
      toolResponse("call-1"),
    ];
    const removed = cascadeRemoveToolResponses(messages, ["call-other"], 1);
    expect(removed).toBe(0);
    expect(messages).toHaveLength(3);
  });

  it("removes multiple matching toolResponses from mixed history", () => {
    const messages: Message[] = [
      userMsg("a"),
      assistantMsg("", ["call-1", "call-2"]),
      toolResponse("call-1"),
      toolResponse("call-2"),
      assistantMsg("done"),
    ];
    const removed = cascadeRemoveToolResponses(messages, ["call-1", "call-2"], 1);
    expect(removed).toBe(2);
    expect(messages).toHaveLength(3);
    expect(messages[2]?.role).toBe("assistant");
  });

  it("does not remove non-matching toolResponses", () => {
    const messages: Message[] = [
      assistantMsg("", ["call-a"]),
      toolResponse("call-a"),
      assistantMsg("", ["call-b"]),
      toolResponse("call-b"),
    ];
    const removed = cascadeRemoveToolResponses(messages, ["call-a"], 1);
    expect(removed).toBe(1);
    expect(messages).toHaveLength(3);
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[2]?.role).toBe("toolResponse");
  });

  it("returns 0 for empty ids array", () => {
    const messages: Message[] = [userMsg("a"), toolResponse("call-1")];
    const removed = cascadeRemoveToolResponses(messages, [], 0);
    expect(removed).toBe(0);
    expect(messages).toHaveLength(2);
  });

  it("scans only forward from fromIndex", () => {
    const messages: Message[] = [
      assistantMsg("", ["call-1"]),
      toolResponse("call-1"),
      assistantMsg("", ["call-2"]),
      toolResponse("call-2"),
    ];
    // Start at index 2 — should only find call-2's response
    const removed = cascadeRemoveToolResponses(messages, ["call-1", "call-2"], 2);
    expect(removed).toBe(1);
    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[1]?.role).toBe("toolResponse");
    expect(messages[2]?.role).toBe("assistant");
  });
});
