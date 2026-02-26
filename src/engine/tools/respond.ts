import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import * as vb from "valibot";

const RespondSchema = vb.strictObject({
  attachments: vb.exactOptional(vb.array(vb.pipe(vb.string(), vb.nonEmpty()))),
  content: vb.pipe(vb.string(), vb.nonEmpty()),
  final: vb.exactOptional(vb.boolean(), true),
});

type RespondInput = vb.InferOutput<typeof RespondSchema>;

const respond: ToolDef = {
  description:
    "Send a message to the user. This is the ONLY way to communicate with the user — text written to files is not delivered.\n\n" +
    "Parameters:\n" +
    "- `content`: Your message in plain Markdown.\n" +
    "- `final` (optional, default true): Whether this message ends your turn.\n" +
    "  - `true` — Send the message and stop. Use this for your final answer.\n" +
    '  - `false` — Send an intermediate status update and continue working (e.g. "Looking into it..." before a long task).\n' +
    '- `attachments` (optional): Array of sandbox file paths (e.g. `["/workspace/report.pdf"]`) to attach to the outgoing message. Only supported on Discord.\n\n' +
    "You must call this tool at least once per turn. Every turn must end with a `final: true` respond call.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const { content, final, attachments } = vb.parse(RespondSchema, input);
    await ctx.send(content, attachments);
    return { final, sent: true };
  },
  name: "respond",
  parameters: RespondSchema,
};

export { respond };
export type { RespondInput };
