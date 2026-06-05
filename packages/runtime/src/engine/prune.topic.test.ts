import { describe, expect, test } from "vitest";

import type { Message } from "#engine/message.js";
import { applyTopicSubstitution } from "#engine/prune.js";

function isTextContent(ct: unknown): ct is { content: string; type: "text" } {
  return typeof ct === "object" && ct !== null && "type" in ct && ct.type === "text";
}

function makeMsg(id: string, role: "user" | "assistant" | "toolResponse" = "user"): Message {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    content: { content: `message ${id}`, type: "text" },
    id,
    role,
    timestamp: 1,
  } as unknown as Message;
}

describe("applyTopicSubstitution", () => {
  test("returns messages unchanged when no summaries", () => {
    const messages = [makeMsg("a"), makeMsg("b"), makeMsg("c")];
    const result = applyTopicSubstitution(messages, []);
    expect(result).toEqual(messages);
  });

  test("replaces a single summary range", () => {
    const messages = [makeMsg("a"), makeMsg("b"), makeMsg("c"), makeMsg("d")];
    const summaries = [
      {
        displayName: "test-topic",
        endMessageId: "c",
        preserve: [],
        slug: "test-topic",
        startMessageId: "b",
        summary: "Messages b and c summarized.",
      },
    ];

    const result = applyTopicSubstitution(messages, summaries);

    expect(result).toHaveLength(3); // a, summary, d
    expect(result[0]?.id).toBe("a");

    // Summary message
    const [, summaryMsg] = result;
    if (summaryMsg === undefined) {
      throw new TypeError("Summary message is undefined");
    }
    expect(summaryMsg.role).toBe("user");
    expect(isTextContent(summaryMsg.content)).toBe(true);
    if (isTextContent(summaryMsg.content)) {
      expect(summaryMsg.content.content).toContain("test-topic");
      expect(summaryMsg.content.content).toContain("Messages b and c summarized.");
    }

    expect(result[2]?.id).toBe("d");
  });

  test("preserves explicitly marked messages", () => {
    const messages = [makeMsg("a"), makeMsg("b"), makeMsg("c"), makeMsg("d"), makeMsg("e")];
    const summaries = [
      {
        displayName: "with-preserve",
        endMessageId: "d",
        preserve: ["c"],
        slug: "with-preserve",
        startMessageId: "b",
        summary: "Range b-d, keeping c verbatim.",
      },
    ];

    const result = applyTopicSubstitution(messages, summaries);

    // a, summary, c (preserved), e
    expect(result).toHaveLength(4);
    expect(result[0]?.id).toBe("a");

    const [, summaryMsg] = result;
    if (summaryMsg === undefined) {
      throw new TypeError("Summary message is undefined");
    }
    expect(summaryMsg.role).toBe("user");

    expect(result[2]?.id).toBe("c");
    expect(result[3]?.id).toBe("e");
  });

  test("handles multiple summary ranges", () => {
    const messages = [
      makeMsg("a"),
      makeMsg("b"),
      makeMsg("c"),
      makeMsg("d"),
      makeMsg("e"),
      makeMsg("f"),
    ];

    const summaries = [
      {
        displayName: "first",
        endMessageId: "b",
        preserve: [],
        slug: "first",
        startMessageId: "a",
        summary: "First two messages.",
      },
      {
        displayName: "second",
        endMessageId: "e",
        preserve: [],
        slug: "second",
        startMessageId: "d",
        summary: "Messages d-e.",
      },
    ];

    const result = applyTopicSubstitution(messages, summaries);

    // summary1, c, summary2, f
    expect(result).toHaveLength(4);
    const c0 = result[0]?.content;
    expect(isTextContent(c0) && c0.content).toContain("first");
    expect(result[1]?.id).toBe("c");
    const c2 = result[2]?.content;
    expect(isTextContent(c2) && c2.content).toContain("second");
    expect(result[3]?.id).toBe("f");
  });

  test("summary with no matching start is ignored", () => {
    const messages = [makeMsg("a"), makeMsg("b")];
    const summaries = [
      {
        displayName: "missing",
        endMessageId: "b",
        preserve: [],
        slug: "missing",
        startMessageId: "nonexistent",
        summary: "Should not apply.",
      },
    ];

    const result = applyTopicSubstitution(messages, summaries);
    // Neither message starts the summary, so both are kept
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("a");
    expect(result[1]?.id).toBe("b");
  });

  test("preserve can span across multiple summary ranges", () => {
    const messages = Array.from({ length: 6 }, (_unused, idx) => makeMsg(String(idx)));
    const summaries = [
      {
        displayName: "combined",
        endMessageId: "4",
        preserve: ["2"],
        slug: "combined",
        startMessageId: "1",
        summary: "Range 1-4.",
      },
    ];

    const result = applyTopicSubstitution(messages, summaries);

    // 0, summary, 2 (preserved), 5
    expect(result).toHaveLength(4);
    expect(result[0]?.id).toBe("0");
    expect(result[2]?.id).toBe("2");
    expect(result[3]?.id).toBe("5");
  });
});
