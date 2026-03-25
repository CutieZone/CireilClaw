import { ToolError } from "$/engine/errors.js";
import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import * as vb from "valibot";

const ReactSchema = vb.strictObject({
  emoji: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description('Unicode emoji (e.g. "👍") or custom emoji in "name:id" format.'),
  ),
  message_id: vb.pipe(
    vb.optional(vb.nullable(vb.pipe(vb.string(), vb.nonEmpty()))),
    vb.transform((val) => val ?? undefined),
    vb.description(
      "ID of the message to react to. Omit to react to the message that triggered this turn.",
    ),
  ),
});

type ReactInput = vb.InferOutput<typeof ReactSchema>;

const react: ToolDef = {
  description:
    "Add an emoji reaction to a message. " +
    "This does NOT end your turn — combine with `no-response` if you only want to react. " +
    "Only works on platforms that support reactions (check capabilities in system prompt).",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const { emoji, message_id } = vb.parse(ReactSchema, input);

    if (ctx.react === undefined) {
      throw new ToolError("Reactions are not supported on this channel");
    }

    await ctx.react(emoji, message_id);
    return { reacted: true, success: true };
  },
  name: "react",
  parameters: ReactSchema,
};

export { react };
export type { ReactInput };
