import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import * as vb from "valibot";

const ReactSchema = vb.strictObject({
  emoji: vb.pipe(vb.string(), vb.nonEmpty()),
  message_id: vb.exactOptional(vb.pipe(vb.string(), vb.nonEmpty())),
});

type ReactInput = vb.InferOutput<typeof ReactSchema>;

const react: ToolDef = {
  description:
    "Add an emoji reaction to a message. " +
    'Use a Unicode emoji (e.g. "👍") or a Discord custom emoji in `name:id` format. ' +
    "`message_id` is optional — omit it to react to the message that triggered this turn, " +
    "or pass a specific `msgId` from the conversation history to react to an earlier message. " +
    "This does NOT end your turn — combine with `no-response` if you only want to react.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const { emoji, message_id } = vb.parse(ReactSchema, input);

    if (ctx.react === undefined) {
      return { error: "Reactions are not supported on this channel" };
    }

    await ctx.react(emoji, message_id);
    return { reacted: true };
  },
  name: "react",
  parameters: ReactSchema,
};

export { react };
export type { ReactInput };
