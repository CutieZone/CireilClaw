import { describe, expect, it } from "vitest";

import type { Message } from "#engine/message.js";

import { stripMediaForModel } from "./strip.js";

describe("stripMediaForModel", () => {
  it("passes non-user messages through unchanged", () => {
    const messages: Message[] = [
      { content: { content: "hello", type: "text" }, role: "assistant" },
      {
        content: { id: "1", name: "read", output: { success: true }, type: "toolResponse" },
        role: "toolResponse",
      },
    ];
    const result = stripMediaForModel(messages, false, false);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[1]);
  });

  it("strips image blocks when supportsVision is false", () => {
    const messages: Message[] = [
      {
        content: [
          { content: "look at this", type: "text" },
          { data: new Uint8Array(1), mediaType: "image/webp", type: "image" },
        ],
        role: "user",
      },
    ];
    const result = stripMediaForModel(messages, false, true);
    expect(result).toHaveLength(1);
    const content = result[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(1);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test assertion
    expect((content as { type: string }[])[0]).toEqual({ content: "look at this", type: "text" });
  });

  it("strips video blocks when supportsVideo is false", () => {
    const messages: Message[] = [
      {
        content: [
          { content: "watch this", type: "text" },
          {
            attachmentId: "",
            data: new Uint8Array(1),
            mediaType: "video/mp4",
            type: "video",
            url: "",
          },
        ],
        role: "user",
      },
    ];
    const result = stripMediaForModel(messages, true, false);
    expect(result).toHaveLength(1);
    const content = result[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(1);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test assertion
    expect((content as { type: string }[])[0]).toEqual({ content: "watch this", type: "text" });
  });

  it("drops user messages with only images when blind", () => {
    const messages: Message[] = [
      {
        content: { data: new Uint8Array(1), mediaType: "image/webp", type: "image" },
        role: "user",
      },
    ];
    const result = stripMediaForModel(messages, false, false);
    expect(result).toHaveLength(0);
  });

  it("drops user messages with only video when video unsupported", () => {
    const messages: Message[] = [
      {
        content: {
          attachmentId: "",
          data: new Uint8Array(1),
          mediaType: "video/mp4",
          type: "video",
          url: "",
        },
        role: "user",
      },
    ];
    const result = stripMediaForModel(messages, true, false);
    expect(result).toHaveLength(0);
  });

  it("preserves image_ref blocks when supportsVision is true", () => {
    const messages: Message[] = [
      {
        content: { id: "img-1", mediaType: "image/webp", type: "image_ref" },
        role: "user",
      },
    ];
    const result = stripMediaForModel(messages, true, false);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(messages[0]);
  });

  it("strips image_ref blocks when supportsVision is false", () => {
    const messages: Message[] = [
      {
        content: { id: "img-1", mediaType: "image/webp", type: "image_ref" },
        role: "user",
      },
    ];
    const result = stripMediaForModel(messages, false, false);
    expect(result).toHaveLength(0);
  });

  it("preserves video_ref blocks when supportsVideo is true", () => {
    const messages: Message[] = [
      {
        content: {
          attachmentId: "vid-1",
          mediaType: "video/mp4",
          type: "video_ref",
          url: "https://example.com/v.mp4",
        },
        role: "user",
      },
    ];
    const result = stripMediaForModel(messages, false, true);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(messages[0]);
  });

  it("keeps non-media content untouched", () => {
    const messages: Message[] = [
      { content: { content: "plain text", type: "text" }, role: "user" },
    ];
    const result = stripMediaForModel(messages, false, false);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(messages[0]);
  });

  it("preserves array shape after stripping", () => {
    const messages: Message[] = [
      {
        content: [
          { data: new Uint8Array(1), mediaType: "image/webp", type: "image" },
          { content: "caption", type: "text" },
        ],
        role: "user",
      },
    ];
    const result = stripMediaForModel(messages, false, false);
    expect(result).toHaveLength(1);
    const content = result[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(1);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test assertion
    expect((content as { type: string }[])[0]).toEqual({ content: "caption", type: "text" });
  });
});
