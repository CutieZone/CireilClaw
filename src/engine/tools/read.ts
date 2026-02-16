import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";

import { toWebp } from "$/util/image.js";
import { sandboxToReal, sanitizeError } from "$/util/paths.js";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import * as vb from "valibot";

const Schema = vb.strictObject({
  path: vb.pipe(vb.string(), vb.nonEmpty()),
});

// Extensions recognised as images and their corresponding MIME types.
const IMAGE_EXT_TO_MEDIA_TYPE: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export const read: ToolDef = {
  description:
    "Read the full contents of a file within the sandbox. Image files (.jpg, .jpeg, .png, .gif, .webp) are loaded visually and displayed to you in the next turn.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    try {
      const data = vb.parse(Schema, input);
      const realPath = sandboxToReal(data.path, ctx.agentSlug);
      const { size } = await stat(realPath);

      const mediaType = IMAGE_EXT_TO_MEDIA_TYPE[extname(data.path).toLowerCase()];
      if (mediaType !== undefined) {
        const buf = await readFile(realPath);
        const data = await toWebp(
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        );
        ctx.session.pendingImages.push({ data, mediaType: "image/webp", type: "image" });
        return { mediaType, path: data.path, size, success: true, type: "image" };
      }

      const content = await readFile(realPath, "utf8");
      return { content, path: data.path, size, success: true };
    } catch (error: unknown) {
      if (error instanceof vb.ValiError) {
        return { error: error.message, issues: error.issues, success: false };
      }
      return { error: sanitizeError(error, ctx.agentSlug), success: false };
    }
  },
  name: "read",
  parameters: Schema,
};
