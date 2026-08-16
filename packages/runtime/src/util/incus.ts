import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { parse as parseYaml } from "yaml";

import type { IncusConfig, Mount } from "#config/schemas/sandbox.js";
import { onShutdown } from "#util/shutdown.js";

import { root } from "./paths.js";

interface EnvVar {
  key: string;
  value: string;
}

interface IncusExecConfig {
  agentSlug: string;
  args: string[];
  command: string;
  envVars: EnvVar[];
  incus: IncusConfig;
  mounts: readonly Mount[];
  timeout: number;
}

interface ExecOutput {
  type: "output";
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface ExecError {
  type: "error";
  error: string;
}

type ExecResult = ExecOutput | ExecError;

const activeInstances = new Map<string, { incus: IncusConfig; name: string }>();
let shutdownHookRegistered = false;

interface DiskDevice {
  mode: "ro" | "rw";
  name: string;
  source: string;
  target: string;
}

interface IncusDevice {
  path?: unknown;
  readonly?: unknown;
  source?: unknown;
  type?: unknown;
}

function deviceIsReadonly(value: unknown): boolean {
  return value === true || value === "true";
}

interface HostIdentity {
  gid: number;
  uid: number;
}

function hasStatus(value: unknown): value is { status: unknown } {
  return typeof value === "object" && value !== null && "status" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// oxlint-disable promise/no-multiple-resolved
async function capture(args: string[], timeout: number, stdin?: string): Promise<ExecOutput> {
  return await new Promise((resolve) => {
    const proc = spawn("incus", args, {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });
    if (stdin !== undefined) {
      proc.stdin?.end(stdin);
    }

    const timeoutId = setTimeout(() => {
      proc.kill("SIGKILL");
    }, timeout);

    proc.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve({
        exitCode: code ?? -1,
        stderr: code === null ? `Command timed out after ${timeout}ms` : stderr,
        stdout,
        type: "output",
      });
    });
    proc.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve({ exitCode: 1, stderr: error.message, stdout, type: "output" });
    });
  });
}

function instanceName(agentSlug: string): string {
  return `cireilclaw-${agentSlug}`;
}

function projectArgs(incus: IncusConfig): string[] {
  return incus.project === undefined ? [] : ["--project", incus.project];
}

function customDeviceName(target: string): string {
  return `workspace-${createHash("sha256").update(target).digest("hex").slice(0, 12)}`;
}

function diskDevices(agentSlug: string, mounts: readonly Mount[]): DiskDevice[] {
  const agentPath = `${root()}/agents/${agentSlug}`;
  return [
    {
      mode: "rw",
      name: "cireilclaw-workspace",
      source: `${agentPath}/workspace`,
      target: "/workspace",
    },
    {
      mode: "rw",
      name: "cireilclaw-memories",
      source: `${agentPath}/memories`,
      target: "/memories",
    },
    { mode: "rw", name: "cireilclaw-skills", source: `${agentPath}/skills`, target: "/skills" },
    { mode: "ro", name: "cireilclaw-blocks", source: `${agentPath}/blocks`, target: "/blocks" },
    { mode: "rw", name: "cireilclaw-tasks", source: `${agentPath}/tasks`, target: "/tasks" },
    ...mounts.map(({ mode, source, target }) => ({
      mode,
      name: customDeviceName(target),
      source,
      target: `/workspace/${target}`,
    })),
  ];
}

async function instanceState(
  incus: IncusConfig,
  name: string,
): Promise<"missing" | "running" | "stopped"> {
  const result = await capture([...projectArgs(incus), "list", name, "--format", "json"], 10_000);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "Failed to query Incus instances");
  }
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return "missing";
  }
  const parsedItems: unknown[] = parsed;
  const [instance] = parsedItems;
  if (!hasStatus(instance)) {
    throw new Error("Incus returned an invalid instance status response");
  }
  const { status } = instance;
  return status === "Running" ? "running" : "stopped";
}

async function addDiskDevices(
  incus: IncusConfig,
  name: string,
  devices: readonly DiskDevice[],
): Promise<void> {
  for (const device of devices) {
    const result = await capture(
      [
        ...projectArgs(incus),
        "config",
        "device",
        "add",
        name,
        device.name,
        "disk",
        `source=${device.source}`,
        `path=${device.target}`,
        ...(device.mode === "ro" ? ["readonly=true"] : []),
      ],
      30_000,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to add Incus device '${device.name}': ${result.stderr}`);
    }
  }
}

async function reconcileMounts(
  incus: IncusConfig,
  name: string,
  mounts: readonly Mount[],
): Promise<void> {
  const result = await capture([...projectArgs(incus), "config", "device", "show", name], 30_000);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to query Incus devices for '${name}': ${result.stderr}`);
  }

  const parsed: unknown = parseYaml(result.stdout);
  if (!isRecord(parsed)) {
    throw new Error("Incus returned an invalid device response");
  }
  const devices = parsed;
  const desired = new Map(
    diskDevices("", mounts)
      .slice(5)
      .map((device) => [device.name, device]),
  );

  for (const [deviceName, value] of Object.entries(devices)) {
    if (!deviceName.startsWith("workspace-") || typeof value !== "object" || value === null) {
      continue;
    }
    const device = value as IncusDevice;
    const expected = desired.get(deviceName);
    if (expected === undefined) {
      const remove = await capture(
        [...projectArgs(incus), "config", "device", "remove", name, deviceName],
        30_000,
      );
      if (remove.exitCode !== 0) {
        throw new Error(`Failed to remove stale Incus device '${deviceName}': ${remove.stderr}`);
      }
      continue;
    }

    const readonly = expected.mode === "ro";
    if (
      device.type !== "disk" ||
      device.source !== expected.source ||
      device.path !== expected.target ||
      deviceIsReadonly(device.readonly) !== readonly
    ) {
      const update = await capture(
        [
          ...projectArgs(incus),
          "config",
          "device",
          "set",
          name,
          deviceName,
          `source=${expected.source}`,
          `path=${expected.target}`,
          `readonly=${String(readonly)}`,
        ],
        30_000,
      );
      if (update.exitCode !== 0) {
        throw new Error(`Failed to update Incus device '${deviceName}': ${update.stderr}`);
      }
    }
    desired.delete(deviceName);
  }

  await addDiskDevices(incus, name, [...desired.values()]);
}

async function disableShiftOnExistingDevices(
  incus: IncusConfig,
  name: string,
  devices: readonly DiskDevice[],
): Promise<void> {
  for (const device of devices) {
    const result = await capture(
      [...projectArgs(incus), "config", "device", "set", name, device.name, "shift=false"],
      30_000,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to update Incus device '${device.name}': ${result.stderr}`);
    }
  }
}

async function configureInstanceIdentity(
  incus: IncusConfig,
  name: string,
  identity: HostIdentity,
): Promise<void> {
  const rawIdmap = `uid ${identity.uid} ${identity.uid}\ngid ${identity.gid} ${identity.gid}`;
  const idmap = await capture(
    [...projectArgs(incus), "config", "set", name, "raw.idmap", rawIdmap],
    30_000,
  );
  if (idmap.exitCode !== 0) {
    throw new Error(
      `Failed to map host uid/gid ${identity.uid}:${identity.gid} into Incus instance '${name}': ${idmap.stderr}`,
    );
  }
}

async function execAsRoot(
  incus: IncusConfig,
  name: string,
  command: string,
  args: string[] = [],
  stdin?: string,
): Promise<ExecOutput> {
  return await capture(
    [
      ...projectArgs(incus),
      "exec",
      name,
      "--force-noninteractive",
      "--user",
      "0",
      "--",
      command,
      ...args,
    ],
    30_000,
    stdin,
  );
}

function parseAccountName(entry: string, kind: "group" | "user"): string {
  const [name] = entry.trim().split(":", 1);
  if (name === undefined || !/^[a-z_][a-z0-9_-]*[$]?$/iu.test(name)) {
    throw new Error(`Incus returned an invalid ${kind} entry for uid/gid 1000`);
  }
  return name;
}

async function ensureContainerUser(
  incus: IncusConfig,
  name: string,
  agentSlug: string,
): Promise<void> {
  const account = await execAsRoot(incus, name, "getent", ["passwd", "1000"]);
  let username = agentSlug;
  if (account.exitCode === 0) {
    username = parseAccountName(account.stdout, "user");
  } else {
    const group = await execAsRoot(incus, name, "getent", ["group", "1000"]);
    if (group.exitCode !== 0) {
      const createGroup = await execAsRoot(incus, name, "groupadd", ["--gid", "1000", agentSlug]);
      if (createGroup.exitCode !== 0) {
        throw new Error(
          `Failed to create container group for '${agentSlug}': ${createGroup.stderr}`,
        );
      }
    }
    const createUser = await execAsRoot(incus, name, "useradd", [
      "--uid",
      "1000",
      "--gid",
      "1000",
      "--home-dir",
      "/workspace",
      "--no-create-home",
      "--shell",
      "/bin/bash",
      agentSlug,
    ]);
    if (createUser.exitCode !== 0) {
      throw new Error(`Failed to create container user '${agentSlug}': ${createUser.stderr}`);
    }
    username = agentSlug;
  }

  const sudo = await execAsRoot(incus, name, "sudo", ["--version"]);
  if (sudo.exitCode !== 0) {
    return;
  }
  const sudoersPath = "/etc/sudoers.d/cireilclaw-agent";
  const sudoers = await execAsRoot(
    incus,
    name,
    "tee",
    [sudoersPath],
    `${username} ALL=(ALL) NOPASSWD: ALL\n`,
  );
  if (sudoers.exitCode !== 0) {
    throw new Error(`Failed to configure container sudo for '${username}': ${sudoers.stderr}`);
  }
  const permissions = await execAsRoot(incus, name, "chmod", ["0440", sudoersPath]);
  if (permissions.exitCode !== 0) {
    throw new Error(`Failed to secure container sudoers file: ${permissions.stderr}`);
  }
  const valid = await execAsRoot(incus, name, "visudo", ["--check", "--file", sudoersPath]);
  if (valid.exitCode !== 0) {
    throw new Error(`Generated invalid container sudoers file: ${valid.stderr}`);
  }
}

async function setHostname(incus: IncusConfig, name: string, agentSlug: string): Promise<void> {
  const hostname = await execAsRoot(incus, name, "hostname", [agentSlug]);
  if (hostname.exitCode !== 0) {
    throw new Error(`Failed to set hostname inside Incus instance '${name}': ${hostname.stderr}`);
  }
}

async function ensureRunning(
  incus: IncusConfig,
  agentSlug: string,
  mounts: readonly Mount[],
  identity: HostIdentity,
): Promise<void> {
  const name = instanceName(agentSlug);
  const state = await instanceState(incus, name);
  if (state === "missing") {
    const profiles = incus.profiles.flatMap((profile) => ["--profile", profile]);
    const create = await capture(
      [...projectArgs(incus), "init", incus.image, name, ...profiles],
      120_000,
    );
    if (create.exitCode !== 0) {
      throw new Error(`Failed to create Incus instance '${name}': ${create.stderr}`);
    }
    await configureInstanceIdentity(incus, name, identity);
    await addDiskDevices(incus, name, diskDevices(agentSlug, mounts));
  } else if (state === "stopped") {
    await configureInstanceIdentity(incus, name, identity);
    await disableShiftOnExistingDevices(
      incus,
      name,
      diskDevices(agentSlug, mounts).filter(({ name: deviceName }) =>
        deviceName.startsWith("cireilclaw-"),
      ),
    );
  }
  if (state !== "missing") {
    await reconcileMounts(incus, name, mounts);
  }
  if (state !== "running") {
    const start = await capture([...projectArgs(incus), "start", name], 30_000);
    if (start.exitCode !== 0) {
      throw new Error(`Failed to start Incus instance '${name}': ${start.stderr}`);
    }
  }
  await setHostname(incus, name, agentSlug);
  await ensureContainerUser(incus, name, agentSlug);
}

function activeInstanceKey(incus: IncusConfig, name: string): string {
  return `${incus.project ?? "default"}:${name}`;
}

async function stopActiveIncusInstances(): Promise<void> {
  const instances = [...activeInstances.values()];
  await Promise.all(
    instances.map(async ({ incus, name }) => {
      const result = await capture(
        [...projectArgs(incus), "stop", name, "--timeout", "10"],
        20_000,
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to stop Incus instance '${name}' during shutdown: ${result.stderr}`,
        );
      }
    }),
  );
}

function registerShutdownHook(): void {
  if (shutdownHookRegistered) {
    return;
  }
  shutdownHookRegistered = true;
  onShutdown(stopActiveIncusInstances);
}

async function execIncus(cfg: IncusExecConfig): Promise<ExecResult> {
  const name = instanceName(cfg.agentSlug);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    return { error: "Incus requires a POSIX host UID and GID", type: "error" };
  }
  const identity = { gid, uid };
  try {
    await ensureRunning(cfg.incus, cfg.agentSlug, cfg.mounts, identity);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), type: "error" };
  }
  activeInstances.set(activeInstanceKey(cfg.incus, name), { incus: cfg.incus, name });
  registerShutdownHook();

  const environment = [
    { key: "HOME", value: "/workspace" },
    { key: "LANG", value: "C.UTF-8" },
    { key: "LC_ALL", value: "C.UTF-8" },
    ...cfg.envVars,
  ];
  const envArgs = environment.flatMap(({ key, value }) => ["--env", `${key}=${value}`]);
  return await capture(
    [
      ...projectArgs(cfg.incus),
      "exec",
      name,
      "--cwd",
      "/workspace",
      "--force-noninteractive",
      "--user",
      String(uid),
      "--group",
      String(gid),
      ...envArgs,
      "--",
      cfg.command,
      ...cfg.args,
    ],
    cfg.timeout,
  );
}

async function stopIncus(incus: IncusConfig, agentSlug: string, timeout = 30_000): Promise<void> {
  const result = await capture(
    [
      ...projectArgs(incus),
      "stop",
      instanceName(agentSlug),
      "--timeout",
      String(Math.ceil(timeout / 1000)),
    ],
    timeout + 10_000,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to stop Incus instance '${instanceName(agentSlug)}': ${result.stderr}`);
  }
  activeInstances.delete(activeInstanceKey(incus, instanceName(agentSlug)));
}

async function restartIncus(
  incus: IncusConfig,
  agentSlug: string,
  timeout = 30_000,
): Promise<void> {
  const result = await capture(
    [
      ...projectArgs(incus),
      "restart",
      instanceName(agentSlug),
      "--timeout",
      String(Math.ceil(timeout / 1000)),
    ],
    timeout + 10_000,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to restart Incus instance '${instanceName(agentSlug)}': ${result.stderr}`,
    );
  }
}

async function destroyIncus(incus: IncusConfig, agentSlug: string): Promise<void> {
  const result = await capture(
    [...projectArgs(incus), "delete", "--force", instanceName(agentSlug)],
    60_000,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to destroy Incus instance '${instanceName(agentSlug)}': ${result.stderr}`,
    );
  }
  activeInstances.delete(activeInstanceKey(incus, instanceName(agentSlug)));
}

export { destroyIncus, execIncus, restartIncus, stopActiveIncusInstances, stopIncus };
export type { IncusExecConfig };
