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
    "Read the full contents of a file at the given sandbox path and return it as text.\n\n" +
    "Image files (.jpg, .jpeg, .png, .gif, .webp) are automatically converted to WebP and injected into your next turn as a visual — you will see the image, not raw bytes.\n\n" +
    "Allowed path roots: /workspace/, /memories/, /blocks/, /skills/.\n\n" +
    "When to use:\n" +
    "- Inspecting or reviewing file contents before editing.\n" +
    "- Viewing images the user has placed in the workspace.\n\n" +
    "When NOT to use:\n" +
    "- To load a skill by its slug — use `read-skill` instead.\n" +
    "- For files you plan to edit repeatedly — use `open-file` to pin them to context.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    try {
      const data = vb.parse(Schema, input);
      const realPath = sandboxToReal(data.path, ctx.agentSlug);
      const { size } = await stat(realPath);

      const mediaType = IMAGE_EXT_TO_MEDIA_TYPE[extname(data.path).toLowerCase()];
      if (mediaType !== undefined) {
        const buf = await readFile(realPath);
        const webp = await toWebp(
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        );
        ctx.session.pendingImages.push({
          data: webp,
          mediaType: "image/webp",
          type: "image",
        });
        return {
          mediaType,
          path: data.path,
          size,
          success: true,
          type: "image",
        };
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
