import type { ChildProcess } from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";

// oxlint-disable no-template-curly-in-string
import { exec, locate, parseEnvFile, SHELL_METACHAR_PATTERN } from "#util/sandbox.js";

vi.mock("node:fs", {
  spy: true,
});

vi.mock("node:child_process", {
  spy: true,
});

vi.mock("#output/log.js", () => ({
  debug: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("#util/paths.js", () => ({
  root: vi.fn().mockReturnValue("/home/test/.cireilclaw"),
}));

const mockedSpawn = vi.mocked(await import("node:child_process").then((mod) => mod.spawn));
const mockedReadFileSync = vi.mocked(await import("node:fs").then((mod) => mod.readFileSync));
const mockedExistsSync = vi.mocked(await import("node:fs").then((mod) => mod.existsSync));
const mockedWarning = vi.mocked(await import("#output/log.js").then((mod) => mod.warning));

describe("parseEnvFile", () => {
  it("returns empty array when file does not exist", () => {
    mockedExistsSync.mockReturnValue(false);
    expect(parseEnvFile("/nonexistent/.env")).toEqual([]);
  });

  it("parses simple KEY=VALUE pairs", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("DB_HOST=localhost\nDB_PORT=5432\n");
    const result = parseEnvFile("/test/.env");
    expect(result).toEqual([
      { key: "DB_HOST", value: "localhost" },
      { key: "DB_PORT", value: "5432" },
    ]);
  });

  it("ignores comments and blank lines", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("# comment\n\nKEY=val\n  # indented comment\n");
    const result = parseEnvFile("/test/.env");
    expect(result).toEqual([{ key: "KEY", value: "val" }]);
  });

  it("resolves $VAR references from the same file", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("BASE=/opt\nPATH=$BASE/bin\n");
    const result = parseEnvFile("/test/.env");
    expect(result).toEqual([
      { key: "BASE", value: "/opt" },
      { key: "PATH", value: "/opt/bin" },
    ]);
  });

  it("resolves ${VAR} references", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("BASE=/opt\nPATH=${BASE}/bin\n");
    const result = parseEnvFile("/test/.env");
    expect(result).toEqual([
      { key: "BASE", value: "/opt" },
      { key: "PATH", value: "/opt/bin" },
    ]);
  });

  it("resolves ${VAR:-default} with default when var is unset", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("PATH=${UNSET_VAR:-/fallback}\n");
    const result = parseEnvFile("/test/.env");
    expect(result).toEqual([{ key: "PATH", value: "/fallback" }]);
  });

  it("uses host env when variable is not in file", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("PATH=$HOME/bin\n");
    vi.stubEnv("HOME", "/home/testuser");
    const result = parseEnvFile("/test/.env");
    expect(result).toEqual([{ key: "PATH", value: "/home/testuser/bin" }]);
    vi.unstubAllEnvs();
  });

  it("rejects self-referencing variables as undefined", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("A=$A\n");
    const result = parseEnvFile("/test/.env");
    expect(result).toMatchObject({
      message: expect.stringContaining("Undefined variable") as unknown,
      type: "error",
    });
  });

  it("reports undefined variable without default", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("PATH=$MISSING\n");
    const result = parseEnvFile("/test/.env");
    expect(result).toMatchObject({
      message: expect.stringContaining("Undefined variable") as unknown,
      type: "error",
    });
  });

  it("skips lines without = sign", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("JUST_A_WORD\nKEY=val\n");
    const result = parseEnvFile("/test/.env");
    expect(result).toEqual([{ key: "KEY", value: "val" }]);
  });

  it("handles value with = signs", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("CONN=host=localhost port=5432\n");
    const result = parseEnvFile("/test/.env");
    expect(result).toEqual([{ key: "CONN", value: "host=localhost port=5432" }]);
  });
});

describe("locate", () => {
  it("returns absolute path if it exists", () => {
    mockedExistsSync.mockImplementation((program) => program === "/usr/bin/python");
    expect(locate("/usr/bin/python")).toBe("/usr/bin/python");
  });

  it("returns undefined for nonexistent absolute path", () => {
    mockedExistsSync.mockReturnValue(false);
    expect(locate("/nonexistent/binary")).toBeUndefined();
  });

  it("returns undefined for path with .. traversal", () => {
    expect(locate("../etc/passwd")).toBeUndefined();
  });

  it("searches PATH entries", () => {
    mockedExistsSync.mockImplementation((program) => program === "/usr/local/bin/node");
    expect(locate("node", ["/usr/bin", "/usr/local/bin"])).toBe("/usr/local/bin/node");
  });

  it("returns undefined when not found in PATH", () => {
    mockedExistsSync.mockReturnValue(false);
    expect(locate("nonexistent-tool", ["/usr/bin"])).toBeUndefined();
  });
});

describe("SHELL_METACHAR_PATTERN", () => {
  const rejected = [
    "cmd arg",
    'cmd"arg',
    "cmd'arg",
    "cmd|pipe",
    "cmd&bg",
    "cmd;next",
    "cmd$dollar",
    "cmd`backtick",
    String.raw`cmd\escape`,
  ];

  for (const input of rejected) {
    it(`rejects: ${JSON.stringify(input)}`, () => {
      expect(SHELL_METACHAR_PATTERN.test(input)).toBe(true);
    });
  }

  const accepted = ["simple-cmd", "cmd_name", "cmd.name", "cmd123"];

  for (const input of accepted) {
    it(`accepts: ${JSON.stringify(input)}`, () => {
      expect(SHELL_METACHAR_PATTERN.test(input)).toBe(false);
    });
  }
});

function fakeChildProcess(stdout = "", stderr = "", exitCode = 0): ChildProcess {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    kill: vi.fn(),
    on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
      if (event === "close") {
        cb(exitCode);
      }
    }),
    stderr: {
      on: vi.fn((_event: string, cb: (data: Buffer) => void) => {
        cb(Buffer.from(stderr));
      }),
    },
    stdout: {
      on: vi.fn((_event: string, cb: (data: Buffer) => void) => {
        cb(Buffer.from(stdout));
      }),
    },
  } as unknown as ChildProcess;
}

describe("exec", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("PATH", "/usr/bin");
  });

  it("rejects commands with shell metacharacters", async () => {
    const result = await exec({
      agentSlug: "test",
      binaries: ["ls"],
      command: "ls -la",
      hostEnvPassthrough: [],
      timeout: 5000,
    });
    expect(result.type).toBe("error");
  });

  it("rejects commands not in allowed binaries list", async () => {
    const result = await exec({
      agentSlug: "test",
      binaries: ["ls"],
      command: "rm",
      hostEnvPassthrough: [],
      timeout: 5000,
    });
    expect(result.type).toBe("error");
  });

  it("bypasses sandbox when insecure env var is set to i-am-in-a-container", async () => {
    vi.stubEnv(
      "CIREILCLAW_RUNTIME_INSECURE_DISABLE_SANDBOX_I_AM_100_PERCENT_SURE",
      "i-am-in-a-container",
    );
    mockedExistsSync.mockImplementation((path) => path === "/usr/bin/echo");
    mockedSpawn.mockReturnValue(fakeChildProcess("hello", "", 0));

    const result = await exec({
      agentSlug: "test",
      args: ["hello"],
      binaries: ["echo"],
      command: "echo",
      hostEnvPassthrough: [],
      timeout: 5000,
    });

    expect(mockedWarning).toHaveBeenCalled();
    expect(mockedSpawn).toHaveBeenCalledWith(
      "/usr/bin/echo",
      ["hello"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "hello", type: "output" });
  });

  it("bypasses sandbox with alternative undocumented value", async () => {
    vi.stubEnv(
      "CIREILCLAW_RUNTIME_INSECURE_DISABLE_SANDBOX_I_AM_100_PERCENT_SURE",
      "babe-i-brought-protection",
    );
    mockedExistsSync.mockImplementation((path) => path === "/usr/bin/whoami");
    mockedSpawn.mockReturnValue(fakeChildProcess("root", "", 0));

    const result = await exec({
      agentSlug: "test",
      binaries: ["whoami"],
      command: "whoami",
      hostEnvPassthrough: [],
      timeout: 5000,
    });

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "root", type: "output" });
  });

  it("bypasses sandbox with we-are-literally-transbians-what value", async () => {
    vi.stubEnv(
      "CIREILCLAW_RUNTIME_INSECURE_DISABLE_SANDBOX_I_AM_100_PERCENT_SURE",
      "we-are-literally-transbians-what",
    );
    mockedExistsSync.mockImplementation((path) => path === "/usr/bin/id");
    mockedSpawn.mockReturnValue(fakeChildProcess("uid=0", "", 0));

    const result = await exec({
      agentSlug: "test",
      binaries: ["id"],
      command: "id",
      hostEnvPassthrough: [],
      timeout: 5000,
    });

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "uid=0", type: "output" });
  });
});
