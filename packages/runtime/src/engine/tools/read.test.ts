import { beforeEach, describe, expect, it, vi } from "vitest";

import { read } from "#engine/tools/read.js";
import type { ToolContext } from "#engine/tools/tool-def.js";
import { VIDEO_SIZE_CAP } from "#supports.js";

const mockFsPromises = {
  readFile: vi.fn(),
  stat: vi.fn(),
};

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]): unknown => mockFsPromises.readFile(...args),
  stat: (...args: unknown[]): unknown => mockFsPromises.stat(...args),
}));

vi.mock("#engine/outline.js", () => ({
  generateOutline: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("#util/image.js", () => ({
  toWebp: vi.fn(),
}));

function makeToolContext(): ToolContext {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    addImage: vi.fn(),
    addVideo: vi.fn(),
    agentSlug: "testagent",
    paths: {
      checkConditionalAccess: vi.fn().mockResolvedValue(undefined),
      resolve: vi.fn().mockResolvedValue("/real/path"),
    },
  } as unknown as ToolContext;
}

describe("read tool media handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { extension: ".m4v", mediaType: "video/mp4" },
    { extension: ".mov", mediaType: "video/quicktime" },
    { extension: ".mp4", mediaType: "video/mp4" },
    { extension: ".webm", mediaType: "video/webm" },
  ])(
    "queues $extension as video bytes instead of decoding it as text",
    async ({ extension, mediaType }) => {
      const bytes = Buffer.from([0, 1, 2, 3, 4]);
      const filePath = `/workspace/clip${extension}`;
      mockFsPromises.stat.mockResolvedValue({ size: bytes.length });
      mockFsPromises.readFile.mockResolvedValue(bytes);
      const ctx = makeToolContext();

      const result = await read.execute({ path: filePath }, ctx);

      expect(result).toEqual({
        mediaType,
        path: filePath,
        size: bytes.length,
        success: true,
        type: "video",
      });
      expect(ctx.addVideo).toHaveBeenCalledWith(bytes, mediaType);
      expect(mockFsPromises.readFile).toHaveBeenCalledWith("/real/path");
    },
  );

  it("rejects MP4 files over the video size limit", async () => {
    mockFsPromises.stat.mockResolvedValue({ size: VIDEO_SIZE_CAP + 1 });
    const ctx = makeToolContext();

    await expect(read.execute({ path: "/workspace/large.mp4" }, ctx)).rejects.toThrow(
      "Video exceeds",
    );
    expect(mockFsPromises.readFile).not.toHaveBeenCalled();
    expect(ctx.addVideo).not.toHaveBeenCalled();
  });
});

describe("read tool binary detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects files containing a high ratio of non-printable bytes", async () => {
    const bytes = Buffer.from("prefix\u0001\u0002\u0003\u0004\u0005suffix", "binary");
    mockFsPromises.stat.mockResolvedValue({ size: bytes.length });
    mockFsPromises.readFile.mockResolvedValue(bytes);
    const ctx = makeToolContext();

    await expect(read.execute({ path: "/workspace/archive.dat", raw: true }, ctx)).rejects.toThrow(
      "Refusing to read binary file as text",
    );
  });

  it("allows ordinary text whitespace", async () => {
    const bytes = Buffer.from("hello\tworld\n", "utf8");
    mockFsPromises.stat.mockResolvedValue({ size: bytes.length });
    mockFsPromises.readFile.mockResolvedValue(bytes);
    const ctx = makeToolContext();

    const result = await read.execute({ path: "/workspace/notes.txt" }, ctx);

    expect(result).toEqual({
      content: "hello\tworld\n",
      path: "/workspace/notes.txt",
      size: bytes.length,
      success: true,
    });
  });
});
