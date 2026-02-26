import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import { sandboxToReal } from "$/util/paths.js";
import * as vb from "valibot";

const Schema = vb.strictObject({
  message_id: vb.pipe(vb.string(), vb.nonEmpty()),
  to: vb.pipe(vb.string(), vb.nonEmpty()),
});

const discordDownloadAttachments: ToolDef = {
  description:
    "Download all file attachments from a Discord message into the sandbox.\n\n" +
    "Parameters:\n" +
    "- `message_id`: The Discord message ID whose attachments to download.\n" +
    "- `to`: Sandbox directory path to save files into (e.g. `/workspace/downloads`).\n\n" +
    "Returns the list of saved sandbox paths. Only available on Discord sessions.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    if (ctx.downloadDiscordAttachments === undefined) {
      return { error: "discord-download-attachments is only available on Discord sessions" };
    }

    const { message_id, to } = vb.parse(Schema, input);

    const files = await ctx.downloadDiscordAttachments(message_id);

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
  name: "discord-download-attachments",
  parameters: Schema,
};

export { discordDownloadAttachments };
