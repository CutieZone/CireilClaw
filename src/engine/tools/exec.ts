import type { ExecToolConfigSchema } from "$/config/index.js";
import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";

import { loadTools } from "$/config/index.js";
import { exec as sandboxExec } from "$/util/sandbox.js";
import * as vb from "valibot";

const Schema = vb.strictObject({
  args: vb.exactOptional(vb.array(vb.pipe(vb.string(), vb.nonEmpty())), []),
  command: vb.pipe(vb.string(), vb.nonEmpty()),
});

function isExecConfig(value: unknown): value is vb.InferOutput<typeof ExecToolConfigSchema> {
  return typeof value === "object" && value !== null && "binaries" in value;
}

export const exec: ToolDef = {
  description:
    "Execute a command in a sandboxed environment. Only commands in the configured binaries list are allowed. Commands run with /workspace as the working directory.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    try {
      const data = vb.parse(Schema, input);
      const toolsConfig = await loadTools(ctx.agentSlug);
      const execConfig = toolsConfig["exec"];

      if (execConfig === false) {
        return { error: "Exec tool is disabled in configuration.", success: false };
      }

      if (!isExecConfig(execConfig)) {
        return {
          error:
            "Exec tool configuration is invalid or missing. Configure [exec] with binaries list in tools.toml.",
          success: false,
        };
      }

      if (!execConfig.enabled) {
        return { error: "Exec tool is disabled in configuration.", success: false };
      }

      const result = await sandboxExec({
        agentSlug: ctx.agentSlug,
        args: data.args,
        binaries: execConfig.binaries,
        command: data.command,
        timeout: execConfig.timeout ?? 60_000,
      });

      if (result.type === "error") {
        return { error: result.error, success: false };
      }

      return {
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        success: result.exitCode === 0,
      };
    } catch (error: unknown) {
      if (error instanceof vb.ValiError) {
        return { error: error.message, issues: error.issues, success: false };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { error: message, success: false };
    }
  },
  name: "exec",
  parameters: Schema,
};
