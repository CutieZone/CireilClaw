import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import * as vb from "valibot";

import { ToolError } from "#engine/errors.js";
import { generateOutline } from "#engine/outline.js";
import type { ToolContext, ToolDef } from "#engine/tools/tool-def.js";
import { IMAGE_EXT_TO_MEDIA_TYPE, VIDEO_EXT_TO_MEDIA_TYPE, VIDEO_SIZE_CAP } from "#supports.js";
import { toWebp } from "#util/image.js";

const BINARY_SAMPLE_BYTES = 8192;
const NON_PRINTABLE_RATIO = 0.1;

function hasBinaryBytes(data: Uint8Array): boolean {
  const sampleLength = Math.min(data.byteLength, BINARY_SAMPLE_BYTES);
  if (sampleLength === 0) {
    return false;
  }

  let nonPrintableBytes = 0;
  for (let index = 0; index < sampleLength; index++) {
    const byte = data[index];
    if (byte === undefined) {
      continue;
    }
    if (byte === 0) {
      return true;
    }

    const isWhitespace = byte === 9 || byte === 10 || byte === 12 || byte === 13;
    if ((!isWhitespace && byte < 32) || byte === 127) {
      nonPrintableBytes++;
    }
  }

  return nonPrintableBytes / sampleLength >= NON_PRINTABLE_RATIO;
}

const Schema = vb.strictObject({
  path: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("Sandbox path to read (e.g. /workspace/notes.txt)."),
  ),
  raw: vb.pipe(
    vb.optional(vb.boolean(), false),
    vb.description("Always gives the raw content of the file, skipping the section subsystem."),
  ),
});

export const read: ToolDef = {
  description:
    "Read the full contents of a file at the given sandbox path and return it as text.\n\n" +
    "Image files are automatically converted to WebP and injected into your next turn as a visual — you will see the image, not raw bytes.\n\n" +
    "MP4 files are injected into your next turn as video — you will see the video, not raw bytes.\n\n" +
    "Binary files are rejected instead of being decoded as text.\n\n" +
    "Allowed path roots: /workspace/, /memories/, /blocks/, /skills/.\n" +
    "Note that paths used here *must* be absolute.\n" +
    "When to use:\n" +
    "- Inspecting or reviewing file contents before editing.\n" +
    "- Viewing images or MP4 videos the user has placed in the workspace.\n\n" +
    "When NOT to use:\n" +
    "- To load a skill by its slug — use `read-skill` instead.\n" +
    "- For files you plan to edit repeatedly — use `open-file` to pin them to context.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(Schema, input);
    const realPath = await ctx.paths.resolve(data.path);

    await ctx.paths.checkConditionalAccess(data.path);

    const { size } = await stat(realPath);
    const extension = path.extname(data.path).toLowerCase();

    const imageMediaType = IMAGE_EXT_TO_MEDIA_TYPE[extension];
    if (imageMediaType !== undefined) {
      const buf = await readFile(realPath);
      const webp = await toWebp(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        imageMediaType,
      );
      ctx.addImage(webp, "image/webp");
      return {
        mediaType: imageMediaType,
        path: data.path,
        size,
        success: true,
        type: "image",
      };
    }

    const videoMediaType = VIDEO_EXT_TO_MEDIA_TYPE[extension];
    if (videoMediaType !== undefined) {
      if (size > VIDEO_SIZE_CAP) {
        throw new ToolError(
          `Video exceeds the ${VIDEO_SIZE_CAP}-byte size limit: ${data.path}`,
          "Use a smaller video file.",
        );
      }

      const buf = await readFile(realPath);
      ctx.addVideo(buf, videoMediaType);
      return {
        mediaType: videoMediaType,
        path: data.path,
        size,
        success: true,
        type: "video",
      };
    }

    const buf = await readFile(realPath);
    if (hasBinaryBytes(buf)) {
      throw new ToolError(
        `Refusing to read binary file as text: ${data.path}`,
        "Use a format-specific reader or inspect the file with exec.",
      );
    }
    const content = buf.toString("utf8");

    if (data.raw) {
      // Short-circuit raw read
      return { content, path: data.path, size, success: true };
    }

    // If the file is large, return an outline instead of full content.
    const outline = await generateOutline(data.path, ctx.agentSlug, content);
    if (outline !== undefined) {
      return { outline, path: data.path, size, success: true };
    }

    return { content, path: data.path, size, success: true };
  },
  name: "read",
  parameters: Schema,
};
