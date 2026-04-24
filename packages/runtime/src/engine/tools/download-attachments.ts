import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import * as vb from "valibot";

import { ToolError } from "#engine/errors.js";
import type { ToolContext, ToolDef } from "#engine/tools/tool-def.js";

const Schema = vb.strictObject({
  message_id: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("ID of the message whose attachments to download."),
  ),
  to: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("Sandbox directory path to save files into (e.g. /workspace/downloads)."),
  ),
});

const downloadAttachments: ToolDef = {
  description:
    "Download all file attachments from a message into the sandbox. Returns the list of saved sandbox paths.\n\n" +
    "Only works on platforms that support attachment downloads (check capabilities in system prompt).",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    if (ctx.channel.downloadAttachments === undefined) {
      throw new ToolError("This channel does not support downloading attachments");
    }

    const { message_id, to } = vb.parse(Schema, input);

    const files = await ctx.channel.downloadAttachments(message_id);

    const saved: string[] = [];
    for (const { filename, data } of files) {
      const sandboxPath = join(to, `${message_id}-${filename}`).replaceAll("\\", "/");

      await ctx.paths.checkConditionalAccess(sandboxPath);

      const realPath = await ctx.paths.resolve(sandboxPath);

      if (existsSync(realPath)) {
        throw new ToolError(
          `File already exists at ${sandboxPath}`,
          "Choose a different path, or if necessary remove the previous file.",
        );
      }

      await mkdir(dirname(realPath), { recursive: true });
      await writeFile(realPath, data);
      saved.push(sandboxPath);
    }

    return { count: saved.length, saved, success: true };
  },
  name: "download-attachments",
  parameters: Schema,
};

export { downloadAttachments };
