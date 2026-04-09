import { loadTools } from "$/config/index.js";
import { ToolError } from "$/engine/errors.js";
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

function truncate(str: string, label: string): string {
  const MAX_OUTPUT = 5000;
  const HEAD_LIMIT = 1000;
  const TAIL_LIMIT = 3500;

  if (str.length <= MAX_OUTPUT) {
    return str;
  }

  const omitted = str.length - (HEAD_LIMIT + TAIL_LIMIT);
  return `${str.slice(0, HEAD_LIMIT)}\n\n... [${omitted} characters omitted from middle of ${label}] ...\n\n${str.slice(-TAIL_LIMIT)}`;
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
    "Tip: Use list-dir with path /bin to see which binaries are available in the sandbox.\n" +
    "Tip: The `/workspace/.env` file *is* sourced and can affect your $PATH and other environment variables.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(Schema, input);
    const toolsConfig = await loadTools(ctx.agentSlug);
    const execConfig = toolsConfig.exec;

    if (execConfig === false || !execConfig.enabled) {
      throw new ToolError("Exec tool is disabled in configuration.");
    }

    if (!execConfig.binaries.includes(data.command)) {
      const bashAvailable = execConfig.binaries.includes("bash");
      throw new ToolError(
        `Command '${data.command}' is not in the allowed binaries list.`,
        bashAvailable
          ? "Use `bash -c 'command'` if you think the binary is in your $PATH (e.g., from .env)."
          : undefined,
      );
    }

    const result = await sandboxExec({
      agentSlug: ctx.agentSlug,
      args: data.args,
      binaries: execConfig.binaries,
      command: data.command,
      hostEnvPassthrough: execConfig.hostEnvPassthrough,
      timeout: execConfig.timeout,
    });

    if (result.type === "error") {
      throw new ToolError(result.error);
    }

    return {
      exitCode: result.exitCode,
      stderr: truncate(result.stderr, "stderr"),
      stderrLength: result.stderr.length,
      stdout: truncate(result.stdout, "stdout"),
      stdoutLength: result.stdout.length,
      success: result.exitCode === 0,
    };
  },
  name: "exec",
  parameters: Schema,
};
