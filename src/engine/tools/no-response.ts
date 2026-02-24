import type { ToolDef } from "$/engine/tools/tool-def.js";
import * as vb from "valibot";

const NoResponseSchema = vb.strictObject({});

const noResponse: ToolDef = {
  description:
    "Explicitly decline to respond to the user. Use this when the message doesn't warrant a reply — " +
    "e.g. someone else's conversation, noise you should ignore, or a command already handled silently. " +
    "This ends your turn without sending any message.",
  // oxlint-disable-next-line typescript/require-await
  async execute(_input: unknown, _ctx): Promise<Record<string, unknown>> {
    return { final: true };
  },
  name: "no-response",
  parameters: NoResponseSchema,
};

export { noResponse };
