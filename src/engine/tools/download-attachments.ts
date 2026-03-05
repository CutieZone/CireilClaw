import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import { sandboxToReal } from "$/util/paths.js";
import * as vb from "valibot";

const Schema = vb.strictObject({
  message_id: vb.pipe(vb.string(), vb.nonEmpty()),
  to: vb.pipe(vb.string(), vb.nonEmpty()),
});

const downloadAttachments: ToolDef = {
  description:
    "Download all file attachments from a message into the sandbox.\n\n" +
    "Parameters:\n" +
    "- `message_id`: The message ID whose attachments to download.\n" +
    "- `to`: Sandbox directory path to save files into (e.g. `/workspace/downloads`).\n\n" +
    "Returns the list of saved sandbox paths. Only available on platforms that support attachment downloads.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    if (ctx.downloadAttachments === undefined) {
      return { error: "This channel does not support downloading attachments" };
    }

    const { message_id, to } = vb.parse(Schema, input);

    const files = await ctx.downloadAttachments(message_id);

    const saved: string[] = [];
    for (const { filename, data } of files) {
      const sandboxPath = join(to, filename).replaceAll("\\", "/");
      const realPath = sandboxToReal(sandboxPath, ctx.agentSlug);
      await mkdir(dirname(realPath), { recursive: true });
      await writeFile(realPath, data);
      saved.push(sandboxPath);
    }

    return { count: saved.length, saved };
  },
  name: "download-attachments",
  parameters: Schema,
};

export { downloadAttachments };
