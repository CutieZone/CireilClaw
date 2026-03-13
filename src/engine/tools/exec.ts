import { loadTools } from "$/config/index.js";
import type { ExecToolConfigSchema } from "$/config/schemas.js";
import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import { exec as sandboxExec } from "$/util/sandbox.js";
import * as vb from "valibot";

const SHELL_METACHAR_PATTERN = /[\s"'|&;$`\\]/;
const Schema = vb.strictObject({
  args: vb.pipe(
    vb.optional(vb.nullable(vb.array(vb.pipe(vb.string(), vb.nonEmpty())))),
    vb.transform((val) => val ?? []),
    vb.description(
      "Arguments to pass to the command (each a separate string, no shell quoting needed).",
    ),
  ),
  command: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.custom(
      (value) => typeof value === "string" && !SHELL_METACHAR_PATTERN.test(value),
      "Command must be a single binary name without spaces or shell metacharacters. Use 'args' for arguments.",
    ),
    vb.description(
      "Binary name to run — must be listed in tools.toml [exec] binaries. No spaces or shell metacharacters.",
    ),
  ),
});

function isExecConfig(value: unknown): value is vb.InferOutput<typeof ExecToolConfigSchema> {
  return typeof value === "object" && value !== null && "binaries" in value;
}

export const exec: ToolDef = {
  description:
    "Run a binary inside a bubblewrap sandbox. The working directory is /workspace.\n\n" +
    "Only binaries explicitly listed in the agent's tools.toml [exec] config are available — all other commands will fail. Returns stdout, stderr, and exit code.\n\n" +
    "When to use:\n" +
    "- Running build tools, linters, formatters, scripts, or other CLI programs.\n" +
    "- Performing operations that cannot be expressed with the other file tools (e.g., grep, git, compilation).\n\n" +
    "Constraints:\n" +
    "- Filesystem access outside the sandbox is restricted.\n" +
    "- Commands that exceed the configured timeout are killed automatically.\n\n" +
    "Tip: Run `ls /bin` to see which binaries are available in the sandbox.\n" +
    "Tip: The `/workspace/.env` file *is* sourced and can affect your $PATH and other environment variables.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    try {
      const data = vb.parse(Schema, input);
      const toolsConfig = await loadTools(ctx.agentSlug);
      const execConfig = toolsConfig["exec"];

      if (execConfig === false) {
        return {
          error: "Exec tool is disabled in configuration.",
          success: false,
        };
      }

      if (!isExecConfig(execConfig)) {
        return {
          error:
            "Exec tool configuration is invalid or missing. Configure [exec] with binaries list in tools.toml.",
          success: false,
        };
      }

      if (!execConfig.enabled) {
        return {
          error: "Exec tool is disabled in configuration.",
          success: false,
        };
      }

      if (!execConfig.binaries.includes(data.command)) {
        const bashAvailable = execConfig.binaries.includes("bash");
        return {
          error: `Command '${data.command}' is not in the allowed binaries list.`,
          ...(bashAvailable && {
            hint: "Use `bash -c 'command'` if you think the binary is in your $PATH (e.g., from .env).",
          }),
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
