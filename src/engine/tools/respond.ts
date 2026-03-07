import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import * as vb from "valibot";

const RespondSchema = vb.strictObject({
  attachments: vb.pipe(
    vb.optional(vb.nullable(vb.array(vb.pipe(vb.string(), vb.nonEmpty())))),
    vb.transform((val) => val ?? undefined),
    vb.description(
      'Sandbox file paths to attach to the outgoing message (e.g. ["/workspace/report.pdf"]). Only used on platforms that support file attachments.',
    ),
  ),
  content: vb.pipe(vb.string(), vb.nonEmpty(), vb.description("Your message in plain Markdown.")),
  final: vb.pipe(
    vb.optional(vb.nullable(vb.boolean())),
    vb.transform((val) => val ?? true),
    vb.description(
      "Whether this message ends your turn. true = stop after sending; false = send an intermediate update and continue working. Defaults to true.",
    ),
  ),
});

type RespondInput = vb.InferOutput<typeof RespondSchema>;

const respond: ToolDef = {
  description:
    "Send a message to the user. This is the ONLY way to communicate — text written to files is not delivered.\n\n" +
    'Set `final: false` to send an intermediate status update and keep working (e.g. "Looking into it..." before a long task); `true` (default) ends the turn.\n\n' +
    "You must call this tool at least once per turn. Every turn must end with either a `final: true` respond call or a `no-response` call.",
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
