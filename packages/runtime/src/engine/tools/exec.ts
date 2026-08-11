import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import * as vb from "valibot";

import { ToolError } from "#engine/errors.js";
import type { ToolContext, ToolDef } from "#engine/tools/tool-def.js";
import { warning } from "#output/log.js";
import { exec as sandboxExec, SHELL_METACHAR_PATTERN } from "#util/sandbox.js";

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
    vb.description("Binary name to run. No spaces or shell metacharacters."),
  ),
});

function buildPreview(
  text: string,
  head: number,
  tail: number,
  totalBytes: number,
  pathKey: string,
): string | undefined {
  const lines = text.split("\n");
  if (lines.length <= head + tail) {
    return undefined;
  }
  const headLines = lines.slice(0, head).join("\n");
  const tailLines = lines.slice(-tail).join("\n");
  return `${headLines}\n... [truncated, ${lines.length} lines (${totalBytes} bytes) — see ${pathKey}] ...\n${tailLines}`;
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function sanitizeForFilename(command: string): string {
  return command.replaceAll(/[^A-Za-z0-9_-]/gu, "_").slice(0, 32) || "cmd";
}

function timestampSlug(): string {
  return new Date().toISOString().replaceAll(/[:.]/gu, "-");
}

const perTurnSeq = new Map<string, number>();

export const exec: ToolDef = {
  description:
    "Run a binary inside the configured sandbox backend. The working directory is /workspace.\n\n" +
    "The Bubblewrap backend exposes only binaries listed in sandbox.toml [bwrap]; Incus executes binaries installed in the container image. Returns the exit code, output lengths, and paths to the captured output.\n\n" +
    "Output capture: stdout and stderr are written to files under the configured outputDir (default /workspace/.exec-output) and the tool result returns the paths, byte counts, and short head/tail previews. Read the files with `read`/`open-file` (large files automatically return an outline) or filter them with `exec grep …` when you need more context. Set `[exec] inline = true` to opt back into raw inline output (only effective when combined stdout+stderr ≤ inlineThresholdBytes, default 16384).\n\n" +
    "When to use:\n" +
    "- Running build tools, linters, formatters, scripts, or other CLI programs.\n" +
    "- Performing operations that cannot be expressed with the other file tools (e.g., grep, git, compilation).\n\n" +
    "Constraints:\n" +
    "- Filesystem access outside the sandbox is restricted.\n" +
    "- With the default Bubblewrap backend, `/blocks` cannot be accessed using `exec`; the Incus backend mounts it read-only.\n" +
    "- Commands that exceed the configured timeout are killed automatically.\n\n" +
    "Tip: Use list-dir with path /bin to see which binaries are available in the sandbox.\n" +
    "Tip: The `/workspace/.env` file *is* sourced and can affect your $PATH and other environment variables.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(Schema, input);
    const execConfig = ctx.cfg.exec;

    if (execConfig === false || !execConfig.enabled) {
      throw new ToolError("Exec tool is disabled in configuration.");
    }

    const bwrapBinaries = ctx.cfg.sandbox.bwrap?.binaries ?? [];
    if (ctx.cfg.sandbox.backend === "bwrap" && !bwrapBinaries.includes(data.command)) {
      const bashAvailable = bwrapBinaries.includes("bash");
      throw new ToolError(
        `Command '${data.command}' is not in sandbox.toml [bwrap] binaries.`,
        bashAvailable
          ? "Use `bash -c 'command'` if you think the binary is in your $PATH (e.g., from .env)."
          : undefined,
      );
    }

    const result = await sandboxExec({
      agentSlug: ctx.agentSlug,
      args: data.args,
      backend: ctx.cfg.sandbox.backend,
      binaries: bwrapBinaries,
      command: data.command,
      devices: ctx.cfg.sandbox.devices,
      hostEnvPassthrough: execConfig.hostEnvPassthrough,
      incus: ctx.cfg.sandbox.incus,
      mounts: ctx.cfg.sandbox.mounts,
      timeout: execConfig.timeout,
    });

    if (result.type === "error") {
      throw new ToolError(result.error);
    }

    const stdoutLength = utf8ByteLength(result.stdout);
    const stderrLength = utf8ByteLength(result.stderr);
    const combinedBytes = stdoutLength + stderrLength;

    const baseResponse: Record<string, unknown> = {
      exitCode: result.exitCode,
      stderrLength,
      stdoutLength,
      success: result.exitCode === 0,
    };

    if (execConfig.inline && combinedBytes <= execConfig.inlineThresholdBytes) {
      return {
        ...baseResponse,
        inline: true,
        stderr: result.stderr,
        stdout: result.stdout,
        truncated: false,
      };
    }

    const turnKey = `${ctx.agentSlug}:${ctx.session.history.length}`;
    const seq = (perTurnSeq.get(turnKey) ?? 0) + 1;
    perTurnSeq.set(turnKey, seq);

    const baseName = `${timestampSlug()}-${String(seq).padStart(3, "0")}-${sanitizeForFilename(data.command)}`;

    // oxlint-disable-next-line init-declarations
    let outputDirHost: string;
    try {
      outputDirHost = await ctx.paths.resolve(execConfig.outputDir);
      await mkdir(outputDirHost, { recursive: true });
    } catch (error) {
      warning(
        {
          error: error instanceof Error ? error.message : String(error),
          outputDir: execConfig.outputDir,
        },
        "Failed to prepare exec output directory; returning output inline as fallback",
      );
      return {
        ...baseResponse,
        fallbackInline: true,
        stderr: result.stderr,
        stdout: result.stdout,
        truncated: false,
      };
    }

    const response: Record<string, unknown> = { ...baseResponse, truncated: true };

    if (stdoutLength > 0) {
      const stdoutPath = `${execConfig.outputDir}/${baseName}.out`;
      const stdoutHostPath = path.join(outputDirHost, `${baseName}.out`);
      try {
        await writeFile(stdoutHostPath, result.stdout, "utf8");
      } catch (error) {
        warning(
          { error: error instanceof Error ? error.message : String(error), stdoutHostPath },
          "Failed to write exec stdout file; returning inline as fallback",
        );
        return {
          ...baseResponse,
          fallbackInline: true,
          stderr: result.stderr,
          stdout: result.stdout,
          truncated: false,
        };
      }
      response["stdoutPath"] = stdoutPath;
      const preview = buildPreview(
        result.stdout,
        execConfig.previewHead,
        execConfig.previewTail,
        stdoutLength,
        "stdoutPath",
      );
      if (preview !== undefined) {
        response["stdoutPreview"] = preview;
      }
    }

    if (stderrLength > 0) {
      const stderrPath = `${execConfig.outputDir}/${baseName}.err`;
      const stderrHostPath = path.join(outputDirHost, `${baseName}.err`);
      try {
        await writeFile(stderrHostPath, result.stderr, "utf8");
      } catch (error) {
        warning(
          { error: error instanceof Error ? error.message : String(error), stderrHostPath },
          "Failed to write exec stderr file; returning inline as fallback",
        );
        return {
          ...baseResponse,
          fallbackInline: true,
          stderr: result.stderr,
          stdout: result.stdout,
          truncated: false,
        };
      }
      response["stderrPath"] = stderrPath;
      const preview = buildPreview(
        result.stderr,
        execConfig.previewHead,
        execConfig.previewTail,
        stderrLength,
        "stderrPath",
      );
      if (preview !== undefined) {
        response["stderrPreview"] = preview;
      }
    }

    return response;
  },
  name: "exec",
  parameters: Schema,
};
