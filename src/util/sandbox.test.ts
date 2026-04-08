// oxlint-disable no-template-curly-in-string
import { locate, parseEnvFile, SHELL_METACHAR_PATTERN } from "$/util/sandbox.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", {
  spy: true,
});

const mockedReadFileSync = vi.mocked(await import("node:fs").then((mod) => mod.readFileSync));
const mockedExistsSync = vi.mocked(await import("node:fs").then((mod) => mod.existsSync));

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
