import { KeyPool } from "@cireilclaw/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ToolResponseContent, VideoContent } from "#engine/content.js";
import type { Message } from "#engine/message.js";

import { flattenContentParts, translateMsg, uploadMedia } from "./oai.js";

function video(): VideoContent {
  return {
    attachmentId: "1",
    data: new Uint8Array([1, 2, 3]),
    mediaType: "video/mp4",
    type: "video",
    url: "https://cdn.example/clip.mp4",
  };
}

// useFilesApi=kimi parks video inside a faked tool response rather than a user
// message, so the media passes have to reach one level deeper than the content
// array. When they didn't, no upload ever ran and the video went out as a
// base64 data URL that Kimi rejects.
function fakeVideoToolResponse(content: VideoContent): Message {
  return {
    content: {
      id: "recv-video-1",
      name: "receive_video",
      output: { _media: [content] },
      type: "toolResponse",
    },
    role: "toolResponse",
  };
}

describe("flattenContentParts", () => {
  it("finds media nested in a tool response's _media", () => {
    const clip = video();
    expect(flattenContentParts([fakeVideoToolResponse(clip)])).toEqual([clip]);
  });

  it("returns the original objects so memoization writes through to history", () => {
    const clip = video();
    const history = [fakeVideoToolResponse(clip)];

    const [collected] = flattenContentParts(history);
    expect(collected).toBe(clip);

    // Stand-in for what uploadMedia does after a successful /files POST.
    if (collected?.type === "video") {
      collected.filesApiMemoized = { fileId: "abc123", mode: "kimi", uploadedAt: 0 };
    }
    expect(clip.filesApiMemoized).toEqual({ fileId: "abc123", mode: "kimi", uploadedAt: 0 });
  });

  it("passes ordinary parts through untouched", () => {
    const clip = video();
    const toolResponse: ToolResponseContent = {
      id: "t1",
      name: "read",
      output: { text: "ok" },
      type: "toolResponse",
    };
    const messages: Message[] = [
      { content: [{ content: "hi", type: "text" }, clip], role: "user" },
      { content: toolResponse, role: "toolResponse" },
    ];

    expect(flattenContentParts(messages)).toEqual([
      { content: "hi", type: "text" },
      clip,
      toolResponse,
    ]);
  });
});

// Hands back a distinct file ID per call so re-uploads are distinguishable.
function stubUploads(): ReturnType<typeof vi.fn> {
  let next = 0;
  const fetchMock = vi.fn(async () => {
    next += 1;
    return await Promise.resolve(Response.json({ id: `file-${next}` }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("uploadMedia", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads video nested in a tool response and references it by ID", async () => {
    const clip = video();
    const message = fakeVideoToolResponse(clip);
    const fetchMock = stubUploads();

    await uploadMedia([message], "https://api.example/v1", new KeyPool("k"), "kimi");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clip.filesApiMemoized?.fileId).toBe("file-1");
    expect(translateMsg(message)).toMatchObject({
      content: [{ video_url: { url: "ms://file-1" } }],
    });
  });

  it("reuses a fresh handle but re-uploads an expired one", async () => {
    const clip = video();
    const history = [fakeVideoToolResponse(clip)];
    const fetchMock = stubUploads();
    const pool = new KeyPool("k");

    await uploadMedia(history, "https://api.example/v1", pool, "kimi");
    await uploadMedia(history, "https://api.example/v1", pool, "kimi");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // ms:// handles expire server-side; a cached ID past its window is dead
    // weight that would fail the whole generation.
    clip.filesApiMemoized = { fileId: "file-1", mode: "kimi", uploadedAt: 0 };
    await uploadMedia(history, "https://api.example/v1", pool, "kimi");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(clip.filesApiMemoized.fileId).toBe("file-2");
  });

  it("does nothing when the files API is off", async () => {
    const fetchMock = stubUploads();

    await uploadMedia(
      [fakeVideoToolResponse(video())],
      "https://api.example/v1",
      new KeyPool("k"),
      false,
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("translateMsg", () => {
  it("references an uploaded video by ms:// instead of inlining base64", () => {
    const clip = video();
    clip.filesApiMemoized = { fileId: "abc123", mode: "kimi", uploadedAt: Date.now() };

    expect(translateMsg(fakeVideoToolResponse(clip))).toEqual({
      content: [{ type: "video_url", video_url: { url: "ms://abc123" } }],
      role: "tool",
      tool_call_id: "recv-video-1",
    });
  });

  it("falls back to an inline data URL when the video was never uploaded", () => {
    const translated = translateMsg(fakeVideoToolResponse(video()));

    expect(translated).toMatchObject({ role: "tool", tool_call_id: "recv-video-1" });
    expect(JSON.stringify(translated)).toContain("data:video/mp4;base64,");
  });

  it("leaves tool responses without media as JSON strings", () => {
    expect(
      translateMsg({
        content: { id: "t1", name: "read", output: { text: "ok" }, type: "toolResponse" },
        role: "toolResponse",
      }),
    ).toEqual({
      content: JSON.stringify({ name: "read", text: "ok" }),
      role: "tool",
      tool_call_id: "t1",
    });
  });
});
