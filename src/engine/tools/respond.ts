import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";

import { Harness } from "$/harness/index.js";
import * as vb from "valibot";

const RespondSchema = vb.strictObject({
  content: vb.pipe(vb.string(), vb.nonEmpty()),
  final: vb.exactOptional(vb.boolean(), true),
});

type RespondInput = vb.InferOutput<typeof RespondSchema>;

const respond: ToolDef = {
  description:
    "THIS IS THE ONLY WAY TO SEND MESSAGES TO THE USER. " +
    "You cannot write to files and have them delivered — you must call this tool to communicate. " +
    "Call it with your reply in `content` (plain Markdown). " +
    "By default (`final: true`) this ends your turn. Set `final: false` to send an intermediate " +
    "update while continuing to work (e.g. 'on it...' before a long task).",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const { content, final } = vb.parse(RespondSchema, input);
    await Harness.get().send(ctx.session, content);
    return { final, sent: true };
  },
  name: "respond",
  parameters: RespondSchema,
};

export { respond };
export type { RespondInput };
