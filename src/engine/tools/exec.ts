import type { ExecToolConfigSchema } from "$/config/index.js";
import { loadTools } from "$/config/index.js";
import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import { exec as sandboxExec } from "$/util/sandbox.js";
import * as vb from "valibot";

const SHELL_METACHAR_PATTERN = /[\s"'|&;$`\\]/;
const Schema = vb.strictObject({
  args: vb.exactOptional(vb.array(vb.pipe(vb.string(), vb.nonEmpty())), []),
  command: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.custom(
      (value) => typeof value === "string" && !SHELL_METACHAR_PATTERN.test(value),
      "Command must be a single binary name without spaces or shell metacharacters. Use 'args' for arguments.",
    ),
  ),
});

function isExecConfig(value: unknown): value is vb.InferOutput<typeof ExecToolConfigSchema> {
  return typeof value === "object" && value !== null && "binaries" in value;
}

export const exec: ToolDef = {
  description:
    "Run a shell command inside a bubblewrap sandbox. The working directory is /workspace.\n\n" +
    "Only binaries explicitly listed in the agent's tools.toml [exec] config are available — all other commands will fail. Returns stdout, stderr, and exit code.\n\n" +
    "Usage:\n" +
    "- 'command' must be a single binary name (no spaces, no shell metacharacters like |, &, ;, $, etc.)\n" +
    "- 'args' is an array of arguments to pass to the command\n\n" +
    "When to use:\n" +
    "- Running build tools, linters, formatters, scripts, or other CLI programs.\n" +
    "- Performing operations that cannot be expressed with the other file tools (e.g., grep, git, compilation).\n\n" +
    "Constraints:\n" +
    "- Network access and filesystem access outside the sandbox are restricted.\n" +
    "- Commands that exceed the configured timeout are killed automatically.\n\n" +
    "Tip: Run `ls /bin` to see which binaries are available in the sandbox.",
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

      if (!execConfig.binaries.includes(data.command)) {
        return {
          error: `Command '${data.command}' is not in the allowed binaries list.`,
          hint: "Use `bash -c 'command'` if you think the binary is in your $PATH (e.g., from .env).",
          success: false,
        };
      }

      const result = await sandboxExec({
        agentSlug: ctx.agentSlug,
        args: data.args,
        binaries: execConfig.binaries,
        command: data.command,
        timeout: execConfig.timeout,
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
