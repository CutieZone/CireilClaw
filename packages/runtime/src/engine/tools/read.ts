import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import * as vb from "valibot";

import type { ToolContext, ToolDef } from "#engine/tools/tool-def.js";
import { IMAGE_EXT_TO_MEDIA_TYPE } from "#supports.js";
import { toWebp } from "#util/image.js";

const Schema = vb.strictObject({
  path: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("Sandbox path to read (e.g. /workspace/notes.txt)."),
  ),
});

export const read: ToolDef = {
  description:
    "Read the full contents of a file at the given sandbox path and return it as text.\n\n" +
    "Image files are automatically converted to WebP and injected into your next turn as a visual — you will see the image, not raw bytes.\n\n" +
    "Allowed path roots: /workspace/, /memories/, /blocks/, /skills/.\n" +
    "Note that paths used here *must* be absolute.\n" +
    "When to use:\n" +
    "- Inspecting or reviewing file contents before editing.\n" +
    "- Viewing images the user has placed in the workspace.\n\n" +
    "When NOT to use:\n" +
    "- To load a skill by its slug — use `read-skill` instead.\n" +
    "- For files you plan to edit repeatedly — use `open-file` to pin them to context.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(Schema, input);
    const realPath = await ctx.paths.resolve(data.path);

    await ctx.paths.checkConditionalAccess(data.path);

    const { size } = await stat(realPath);

    const mediaType = IMAGE_EXT_TO_MEDIA_TYPE[extname(data.path).toLowerCase()];
    if (mediaType !== undefined) {
      const buf = await readFile(realPath);
      const webp = await toWebp(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        mediaType,
      );
      ctx.addImage(webp, "image/webp");
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
  },
  name: "read",
  parameters: Schema,
};
