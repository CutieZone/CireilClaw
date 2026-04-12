import { definePlugin, vb } from "@cireilclaw/sdk";
import type { ToolResult } from "@cireilclaw/sdk";

const echo = {
  description: "Echoes back the input message. Template plugin for demonstration.",
  // oxlint-disable-next-line typescript/require-await
  async execute(input: unknown): Promise<ToolResult> {
    const { message } = vb.parse(this.parameters, input);
    return { echo: message, success: true as const };
  },
  name: "echo",
  parameters: vb.strictObject({
    message: vb.pipe(vb.string(), vb.nonEmpty(), vb.description("The message to echo back")),
  }),
};

// oxlint-disable-next-line import/no-default-export
export default definePlugin(() => ({ name: "template", tools: { echo } }));
