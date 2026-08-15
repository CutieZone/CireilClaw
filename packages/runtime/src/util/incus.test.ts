import type { ChildProcess } from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", { spy: true });
vi.mock("./paths.js", (): { root(): string } => ({
  root: (): string => "/home/test/.cireilclaw",
}));

const mockedSpawn = vi.mocked(await import("node:child_process").then((mod) => mod.spawn));
const { execIncus } = await import("./incus.js");

function fakeChildProcess(stdout = "", stderr = "", exitCode = 0): ChildProcess {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test only models process streams used by capture.
  return {
    kill: vi.fn(),
    on: vi.fn((event: string, callback: (code?: number) => void) => {
      if (event === "close") {
        callback(exitCode);
      }
    }),
    stderr: {
      on: vi.fn((_event: string, callback: (data: Buffer) => void) => {
        callback(Buffer.from(stderr));
      }),
    },
    stdout: {
      on: vi.fn((_event: string, callback: (data: Buffer) => void) => {
        callback(Buffer.from(stdout));
      }),
    },
  } as unknown as ChildProcess;
}

describe("execIncus", (): void => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates, mounts, starts, and executes in a missing agent instance", async () => {
    mockedSpawn.mockImplementation((_command, args) => {
      const argsList = Array.isArray(args) ? args : [];
      if (argsList.includes("list")) {
        return fakeChildProcess("[]");
      }
      if (argsList.includes("exec")) {
        if (
          argsList.includes("getent") &&
          (argsList.includes("passwd") || argsList.includes("group"))
        ) {
          return fakeChildProcess("", "", 2);
        }
        return fakeChildProcess("hello\n");
      }
      return fakeChildProcess();
    });

    const result = await execIncus({
      agentSlug: "test-agent",
      args: ["hello"],
      command: "echo",
      envVars: [{ key: "TOKEN", value: "secret" }],
      incus: { image: "images:fedora/42", profiles: [], project: "cireilclaw" },
      mounts: [{ mode: "ro", source: "/host/reference", target: "reference" }],
      timeout: 5000,
    });

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "hello\n", type: "output" });
    const calls = mockedSpawn.mock.calls.map(([, args]) => args);
    expect(calls).toContainEqual([
      "--project",
      "cireilclaw",
      "init",
      "images:fedora/42",
      "cireilclaw-test-agent",
    ]);
    expect(calls).toContainEqual([
      "--project",
      "cireilclaw",
      "config",
      "set",
      "cireilclaw-test-agent",
      "raw.idmap",
      "uid 1000 1000\ngid 1000 1000",
    ]);
    expect(calls).toContainEqual([
      "--project",
      "cireilclaw",
      "exec",
      "cireilclaw-test-agent",
      "--force-noninteractive",
      "--user",
      "0",
      "--",
      "hostname",
      "test-agent",
    ]);
    expect(calls).toContainEqual(
      expect.arrayContaining([
        "config",
        "device",
        "add",
        "cireilclaw-test-agent",
        "cireilclaw-blocks",
        "disk",
        "source=/home/test/.cireilclaw/agents/test-agent/blocks",
        "path=/blocks",
        "readonly=true",
      ]),
    );
    expect(calls).toContainEqual(
      expect.arrayContaining([
        "exec",
        "cireilclaw-test-agent",
        "--user",
        "0",
        "--",
        "groupadd",
        "--gid",
        "1000",
        "test-agent",
      ]),
    );
    expect(calls).toContainEqual(
      expect.arrayContaining([
        "exec",
        "cireilclaw-test-agent",
        "--user",
        "0",
        "--",
        "useradd",
        "--uid",
        "1000",
        "--home-dir",
        "/workspace",
        "test-agent",
      ]),
    );
    expect(calls).toContainEqual(
      expect.arrayContaining([
        "exec",
        "cireilclaw-test-agent",
        "--user",
        "0",
        "--",
        "tee",
        "/etc/sudoers.d/cireilclaw-agent",
      ]),
    );
    expect(calls).toContainEqual(expect.arrayContaining(["start", "cireilclaw-test-agent"]));
    expect(calls).toContainEqual(
      expect.arrayContaining([
        "exec",
        "cireilclaw-test-agent",
        "--cwd",
        "/workspace",
        "--user",
        "1000",
        "--group",
        "1000",
        "--env",
        "TOKEN=secret",
        "--",
        "echo",
        "hello",
      ]),
    );
  });

  it("reuses a running instance without applying boot-only configuration", async () => {
    mockedSpawn.mockImplementation((_command, args) => {
      const argsList = Array.isArray(args) ? args : [];
      if (argsList.includes("list")) {
        return fakeChildProcess('[{"status":"Running"}]');
      }
      if (argsList.includes("show")) {
        return fakeChildProcess("{}");
      }
      if (argsList.includes("exec")) {
        return fakeChildProcess("hello\n");
      }
      return fakeChildProcess();
    });

    const result = await execIncus({
      agentSlug: "test-agent",
      args: [],
      command: "hostname",
      envVars: [],
      incus: { image: "images:fedora/43", profiles: [] },
      mounts: [],
      timeout: 5000,
    });

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "hello\n", type: "output" });
    const calls = mockedSpawn.mock.calls.map(([, args]) => args);
    expect(
      calls.some(
        (args) =>
          Array.isArray(args) &&
          args.includes("config") &&
          (args.includes("set") || args.includes("add") || args.includes("remove")),
      ),
    ).toBe(false);
    expect(calls.some((args) => Array.isArray(args) && args.includes("start"))).toBe(false);
  });

  it("reconciles configured mounts on an existing instance", async () => {
    mockedSpawn.mockImplementation((_command, args) => {
      const argsList = Array.isArray(args) ? args : [];
      if (argsList.includes("list")) {
        return fakeChildProcess('[{"status":"Running"}]');
      }
      if (argsList.includes("show")) {
        return fakeChildProcess(
          JSON.stringify({
            "workspace-stale": {
              path: "/workspace/stale",
              source: "/host/stale",
              type: "disk",
            },
          }),
        );
      }
      if (argsList.includes("exec")) {
        return fakeChildProcess("hello\n");
      }
      return fakeChildProcess();
    });

    const result = await execIncus({
      agentSlug: "test-agent",
      args: [],
      command: "hostname",
      envVars: [],
      incus: { image: "images:fedora/43", profiles: [] },
      mounts: [{ mode: "ro", source: "/host/reference", target: "reference" }],
      timeout: 5000,
    });

    expect(result.type).toBe("output");
    const calls = mockedSpawn.mock.calls.map(([, args]) => args);
    expect(calls).toContainEqual([
      "config",
      "device",
      "remove",
      "cireilclaw-test-agent",
      "workspace-stale",
    ]);
    expect(
      calls.some(
        (args) =>
          Array.isArray(args) &&
          args.includes("config") &&
          args.includes("device") &&
          args.includes("add") &&
          args.includes("source=/host/reference") &&
          args.includes("path=/workspace/reference") &&
          args.includes("readonly=true"),
      ),
    ).toBe(true);
  });
});
