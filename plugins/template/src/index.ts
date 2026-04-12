import { definePlugin, vb } from "cireilclaw-sdk";

const echo = {
  description: "Echoes back the input message. Template plugin for demonstration.",
  name: "echo",
  parameters: vb.strictObject({
    message: vb.pipe(vb.string(), vb.nonEmpty(), vb.description("The message to echo back")),
  }),
  async execute(input: unknown) {
    const { message } = vb.parse(this.parameters, input);
    return { echo: message, success: true as const };
  },
};

export default definePlugin(() => ({ name: "template", tools: { echo } }));
