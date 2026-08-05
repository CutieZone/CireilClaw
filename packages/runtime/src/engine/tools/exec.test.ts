import { beforeEach, describe, expect, it, vi } from "vitest";

import { exec } from "#engine/tools/exec.js";
import type { ToolContext } from "#engine/tools/tool-def.js";

const mockFsPromises = {
  mkdir: vi.fn(),
  writeFile: vi.fn(),
};

const mockSandboxExec = vi.fn();

vi.mock("node:fs/promises", () => ({
  mkdir: (...args: unknown[]): unknown => mockFsPromises.mkdir(...args),
  writeFile: (...args: unknown[]): unknown => mockFsPromises.writeFile(...args),
}));

vi.mock("#util/sandbox.js", () => ({
  SHELL_METACHAR_PATTERN: /\s/u,
  exec: (...args: unknown[]): unknown => mockSandboxExec(...args),
}));

vi.stubEnv("HOME", "/home/test");

interface ExecOverrides {
  agentSlug?: string;
  historyLength?: number;
  inline?: boolean;
  inlineThresholdBytes?: number;
  outputDir?: string;
  previewHead?: number;
  previewTail?: number;
  stderr?: string;
  stdout?: string;
}

function makeToolContext(overrides: ExecOverrides = {}): ToolContext {
  const resolveMock = vi
    .fn()
    // oxlint-disable-next-line typescript/promise-function-async
    .mockImplementation((sandboxPath: string): Promise<string> => {
      if (sandboxPath === "/workspace/.exec-output") {
        return Promise.resolve("/home/test/.cireilclaw/agents/testagent/workspace/.exec-output");
      }
      return Promise.resolve(sandboxPath);
    });
  const ctx = {
    agentSlug: overrides.agentSlug ?? "testagent",
    cfg: {
      exec: {
        binaries: ["grep", "ls"],
        enabled: true,
        hostEnvPassthrough: [],
        inline: overrides.inline ?? false,
        inlineThresholdBytes: overrides.inlineThresholdBytes ?? 16_384,
        outputDir: overrides.outputDir ?? "/workspace/.exec-output",
        previewHead: overrides.previewHead ?? 20,
        previewTail: overrides.previewTail ?? 20,
        timeout: 60_000,
      },
      sandbox: { devices: {}, mounts: [] },
    },
    paths: { resolve: resolveMock },
    session: {
      history: Array.from({ length: overrides.historyLength ?? 0 }, () => ({})),
    },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return ctx as unknown as ToolContext;
}

function setSandboxResult(stdout: string, stderr: string, exitCode = 0): void {
  mockSandboxExec.mockResolvedValueOnce({
    exitCode,
    stderr,
    stdout,
    type: "output",
  });
}

function setSandboxError(message: string): void {
  mockSandboxExec.mockResolvedValueOnce({
    error: message,
    type: "error",
  });
}

// oxlint-disable-next-line typescript/promise-function-async
function runExec(command: string, ctx: ToolContext): Promise<Record<string, unknown>> {
  return exec.execute({ command }, ctx);
}

describe("exec tool output spilling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFsPromises.mkdir.mockResolvedValue(undefined);
    mockFsPromises.writeFile.mockResolvedValue(undefined);
  });

  it("writes stdout and stderr to separate files when both are non-empty", async () => {
    setSandboxResult("hello\nworld\n", "warn\n");

    const ctx = makeToolContext();
    const result = await runExec("grep", ctx);

    expect(result["success"]).toBe(true);
    expect(result["exitCode"]).toBe(0);
    expect(result["stdoutLength"]).toBe(12);
    expect(result["stderrLength"]).toBe(5);
    expect(result["truncated"]).toBe(true);
    expect(result["stdout"]).toBeUndefined();
    expect(result["stderr"]).toBeUndefined();

    expect(mockFsPromises.writeFile).toHaveBeenCalledTimes(2);
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.exec-output\/.+\.out$/u),
      "hello\nworld\n",
      "utf8",
    );
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.exec-output\/.+\.err$/u),
      "warn\n",
      "utf8",
    );

    const { stdoutPath, stderrPath } = result;
    expect(typeof stdoutPath).toBe("string");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect((stdoutPath as string).startsWith("/workspace/.exec-output/")).toBe(true);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect((stdoutPath as string).endsWith("-001-grep.out")).toBe(true);
    expect(typeof stderrPath).toBe("string");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect((stderrPath as string).endsWith("-001-grep.err")).toBe(true);
  });

  it("skips writing the stderr file and omits stderr fields when stderr is empty", async () => {
    setSandboxResult("only stdout\n", "");

    const ctx = makeToolContext();
    const result = await runExec("grep", ctx);

    expect(mockFsPromises.writeFile).toHaveBeenCalledTimes(1);
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.out$/u),
      "only stdout\n",
      "utf8",
    );
    expect(result["stderrPath"]).toBeUndefined();
    expect(result["stderrPreview"]).toBeUndefined();
    expect(result["stderrLength"]).toBe(0);
    expect(result["stdoutLength"]).toBe(12);
  });

  it("skips writing the stdout file and omits stdout fields when stdout is empty", async () => {
    setSandboxResult("", "only stderr\n");

    const ctx = makeToolContext();
    const result = await runExec("grep", ctx);

    expect(mockFsPromises.writeFile).toHaveBeenCalledTimes(1);
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.err$/u),
      "only stderr\n",
      "utf8",
    );
    expect(result["stdoutPath"]).toBeUndefined();
    expect(result["stdoutPreview"]).toBeUndefined();
    expect(result["stdoutLength"]).toBe(0);
  });

  it("returns raw stdout/stderr inline when inline = true and combined size <= threshold", async () => {
    setSandboxResult("hi\n", "bye\n");

    const ctx = makeToolContext({ inline: true, inlineThresholdBytes: 1024 });
    const result = await runExec("grep", ctx);

    expect(result["inline"]).toBe(true);
    expect(result["truncated"]).toBe(false);
    expect(result["stdout"]).toBe("hi\n");
    expect(result["stderr"]).toBe("bye\n");
    expect(mockFsPromises.writeFile).not.toHaveBeenCalled();
    expect(result["stdoutPath"]).toBeUndefined();
  });

  it("falls back to spilling when inline = true but combined size exceeds threshold", async () => {
    setSandboxResult("x".repeat(2000), "");

    const ctx = makeToolContext({ inline: true, inlineThresholdBytes: 1024 });
    const result = await runExec("grep", ctx);

    expect(result["inline"]).toBeUndefined();
    expect(result["truncated"]).toBe(true);
    expect(result["stdoutPath"]).toBeDefined();
    expect(mockFsPromises.writeFile).toHaveBeenCalledTimes(1);
  });

  it("produces a truncated preview when stdout exceeds head+tail lines", async () => {
    const lines = Array.from({ length: 100 }, (_unused, idx) => `line ${idx + 1}`);
    const stdout = `${lines.join("\n")}\n`;
    setSandboxResult(stdout, "");

    const ctx = makeToolContext({ previewHead: 5, previewTail: 5 });
    const result = await runExec("grep", ctx);

    const preview = result["stdoutPreview"];
    expect(typeof preview).toBe("string");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const previewStr = preview as string;
    expect(previewStr).toContain("line 1");
    expect(previewStr).toContain("line 5");
    expect(previewStr).toContain("line 100");
    expect(previewStr).toContain("line 97");
    expect(previewStr).toContain("[truncated");
    expect(previewStr).toContain("stdoutPath");
    expect(previewStr).not.toContain("line 50");
  });

  it("omits the preview field entirely when output fits within head+tail", async () => {
    setSandboxResult("a\nb\nc\n", "");

    const ctx = makeToolContext({ previewHead: 5, previewTail: 5 });
    const result = await runExec("grep", ctx);

    expect(result["stdoutPreview"]).toBeUndefined();
  });

  it("increments the per-turn sequence counter across calls in the same turn", async () => {
    setSandboxResult("one\n", "");
    setSandboxResult("two\n", "");

    const ctx = makeToolContext({ historyLength: 7 });
    const r1 = await runExec("grep", ctx);
    const r2 = await runExec("grep", ctx);

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect((r1["stdoutPath"] as string).endsWith("-001-grep.out")).toBe(true);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect((r2["stdoutPath"] as string).endsWith("-002-grep.out")).toBe(true);
  });

  it("resets the sequence counter for a new turn (different history length)", async () => {
    setSandboxResult("one\n", "");
    setSandboxResult("two\n", "");

    const ctxTurnA = makeToolContext({ historyLength: 3 });
    const rA = await runExec("grep", ctxTurnA);

    const ctxTurnB = makeToolContext({ historyLength: 4 });
    const rB = await runExec("grep", ctxTurnB);

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect((rA["stdoutPath"] as string).endsWith("-001-grep.out")).toBe(true);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect((rB["stdoutPath"] as string).endsWith("-001-grep.out")).toBe(true);
  });

  it("sanitizes the command name in the output filename", async () => {
    setSandboxResult("x\n", "");

    const ctx = makeToolContext();
    const result = await runExec("grep", ctx);

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const stdoutPath = result["stdoutPath"] as string;
    const basename = stdoutPath.split("/").pop() ?? "";
    expect(basename).not.toContain(" ");
    expect(basename).not.toContain("/");
    expect(basename).toMatch(/-\d{3}-grep\.out$/u);
  });

  it("falls back to inline output when the output directory cannot be prepared", async () => {
    setSandboxResult("hi\n", "warn\n");
    mockFsPromises.mkdir.mockRejectedValueOnce(new Error("EACCES"));

    const ctx = makeToolContext();
    const result = await runExec("grep", ctx);

    expect(result["fallbackInline"]).toBe(true);
    expect(result["truncated"]).toBe(false);
    expect(result["stdout"]).toBe("hi\n");
    expect(result["stderr"]).toBe("warn\n");
    expect(result["stdoutPath"]).toBeUndefined();
  });

  it("falls back to inline output when writing the stdout file fails", async () => {
    setSandboxResult("hi\n", "");
    mockFsPromises.writeFile.mockRejectedValueOnce(new Error("ENOSPC"));

    const ctx = makeToolContext();
    const result = await runExec("grep", ctx);

    expect(result["fallbackInline"]).toBe(true);
    expect(result["stdout"]).toBe("hi\n");
    expect(result["stdoutPath"]).toBeUndefined();
  });

  it("throws ToolError when the sandbox reports an error", async () => {
    setSandboxError("bwrap not found");

    const ctx = makeToolContext();
    await expect(exec.execute({ command: "grep" }, ctx)).rejects.toThrow("bwrap not found");
    expect(mockFsPromises.writeFile).not.toHaveBeenCalled();
  });

  it("rejects commands not in the allowed binaries list", async () => {
    const ctx = makeToolContext();
    await expect(exec.execute({ command: "rm" }, ctx)).rejects.toThrow(
      "not in the allowed binaries list",
    );
    expect(mockSandboxExec).not.toHaveBeenCalled();
  });

  it("rejects shell metacharacters in the command name", async () => {
    const ctx = makeToolContext();
    await expect(exec.execute({ command: "grep; rm" }, ctx)).rejects.toThrow();
    expect(mockSandboxExec).not.toHaveBeenCalled();
  });

  it("handles a single massive line with no preview emitted", async () => {
    const hugeLine = "x".repeat(100_000);
    setSandboxResult(hugeLine, "");

    const ctx = makeToolContext({ previewHead: 20, previewTail: 20 });
    const result = await runExec("grep", ctx);

    expect(result["stdoutLength"]).toBe(100_000);
    expect(result["stdoutPath"]).toBeDefined();
    expect(result["stdoutPreview"]).toBeUndefined();
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.out$/u),
      hugeLine,
      "utf8",
    );
  });

  it("reports UTF-8 byte length, not UTF-16 code units", async () => {
    setSandboxResult("héllo wörld 🎉", "");

    const ctx = makeToolContext();
    const result = await runExec("grep", ctx);

    // "héllo wörld 🎉" is 14 UTF-16 code units but 18 UTF-8 bytes
    expect(result["stdoutLength"]).toBe(18);
  });
});

describe("exec tool bash hint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFsPromises.mkdir.mockResolvedValue(undefined);
    mockFsPromises.writeFile.mockResolvedValue(undefined);
  });

  it("suggests bash -c when an unknown command is used and bash is in the allowlist", async () => {
    const ctx = makeToolContext();
    if (ctx.cfg.exec === false) {
      throw new Error("exec should be enabled");
    }
    ctx.cfg.exec.binaries = ["grep", "bash"];

    // oxlint-disable-next-line init-declarations
    let captured: { hint?: string; message: string } | undefined;
    try {
      await exec.execute({ command: "rg" }, ctx);
    } catch (error) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      captured = error as { hint?: string; message: string };
    }

    expect(captured).toBeDefined();
    expect(captured?.message).toMatch(/not in the allowed binaries list/u);
    expect(captured?.hint).toMatch(/bash -c/u);
  });
});
