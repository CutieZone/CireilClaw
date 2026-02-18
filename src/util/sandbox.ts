import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { parse, isAbsolute, join, resolve as resolvePath } from "node:path";

// oxlint-disable promise/no-multiple-resolved
import { debug, warning } from "$/output/log.js";

function locate(command: string, pathEnvOverride?: string[]): string | undefined {
  if (isAbsolute(command)) {
    return existsSync(command) ? command : undefined;
  }

  const path = parse(command);

  for (const segment of path.dir.split("/")) {
    if (segment.length === 0) {
      continue;
    }
    if (segment === "..") {
      warning({ path: command }, "Detected path traversal in path");
      return undefined;
    }
  }

  const pathEnv = pathEnvOverride ?? (process.env.PATH ?? "").split(":");

  for (const pathEntry of pathEnv) {
    const joined = resolvePath(join(pathEntry, command));

    if (existsSync(joined)) {
      return joined;
    }
  }

  return undefined;
}

interface ExecConfig {
  command: string;
  args?: string[];
  binaries: string[];
  timeout: number;
  agentSlug: string;
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

function buildCommonArgs(home: string, agentSlug: string): string[] {
  return [
    "bwrap",
    "--die-with-parent",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--new-session",
    "--hostname",
    `${agentSlug}-sandbox`,
    "--bind",
    join(home, ".cireilclaw", "agents", agentSlug, "workspace"),
    "/workspace",
    "--bind",
    join(home, ".cireilclaw", "agents", agentSlug, "memories"),
    "/memories",
    "--bind",
    join(home, ".cireilclaw", "agents", agentSlug, "skills"),
    "/skills",
    "--size",
    String(64 * 1024 * 1024),
    "--tmpfs",
    "/tmp",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
  ];
}

function addEtcBindings(args: string[]): void {
  const etcFiles = ["/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/resolv.conf"];

  for (const file of etcFiles) {
    if (existsSync(file)) {
      args.push("--ro-bind", file, file);
    }
  }
}

function addSslCertificates(args: string[]): void {
  const certPaths = [
    "/etc/ssl/certs/ca-bundle.crt",
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/cert.pem",
  ];

  for (const certPath of certPaths) {
    if (existsSync(certPath)) {
      args.push("--ro-bind", certPath, certPath);
    }
  }
}

interface EnvVar {
  key: string;
  value: string;
}

function parseEnvFile(envPath: string): EnvVar[] {
  if (!existsSync(envPath)) {
    return [];
  }

  const content = readFileSync(envPath, "utf8");
  const vars: EnvVar[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    if (key.length === 0) {
      continue;
    }

    vars.push({ key, value });
  }

  return vars;
}

function addEnvironmentVars(args: string[], pathValue: string, extraVars?: EnvVar[]): void {
  args.push("--clearenv");

  const defaultVars: EnvVar[] = [
    { key: "PATH", value: pathValue },
    { key: "HOME", value: "/workspace" },
    { key: "LANG", value: "C.UTF-8" },
    { key: "LC_ALL", value: "C.UTF-8" },
  ];

  const allVars = extraVars ? [...defaultVars, ...extraVars] : defaultVars;

  for (const { key, value } of allVars) {
    args.push("--setenv", key, value);
  }
}

function detectNixOS(): boolean {
  return existsSync("/nix/store");
}

interface NixStoreResult {
  success: boolean;
  requisites: string[];
}

async function queryNixStore(toolPath: string): Promise<NixStoreResult> {
  const prom = new Promise<NixStoreResult>((resolve) => {
    const proc = spawn("nix-store", ["--query", "--requisites", toolPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });

    proc.on("close", (code) => {
      if (resolved) {
        return;
      }
      resolved = true;

      if (code !== 0) {
        warning({ code, stderr, toolPath }, "Failed to execute nix-store query");
        resolve({ requisites: [], success: false });
        return;
      }

      const requisites = stdout.split("\n").filter((it) => it.trim().length > 0);
      resolve({ requisites, success: true });
    });

    proc.on("error", (err) => {
      if (resolved) {
        return;
      }
      resolved = true;

      warning({ error: err.message, toolPath }, "Failed to spawn nix-store");
      resolve({ requisites: [], success: false });
    });
  });

  const result = await prom;
  return result;
}

async function buildNixBindings(args: string[], binaries: string[]): Promise<boolean> {
  args.push("--dir", "/bin");

  const storePaths = new Map<string, { itself: string; requisites: string[] }>();

  for (const tool of binaries) {
    const toolPath = locate(tool, ["/run/current-system/sw/bin"]);

    if (toolPath === undefined) {
      warning({ tool }, "Couldn't locate required tool");
      return false;
    }

    const result = await queryNixStore(toolPath);

    if (!result.success) {
      return false;
    }

    storePaths.set(tool, {
      itself: realpathSync(toolPath),
      requisites: result.requisites,
    });
  }

  const uniquePaths = new Set<string>();
  for (const [, data] of storePaths) {
    for (const path of data.requisites) {
      uniquePaths.add(path);
    }
  }

  for (const path of uniquePaths) {
    args.push("--ro-bind", path, path);
  }

  for (const [key, data] of storePaths) {
    args.push("--symlink", data.itself, `/bin/${key}`);
  }

  return true;
}

function buildGenericLinuxBindings(args: string[], binaries: string[]): boolean {
  const systemDirs = ["/usr", "/bin", "/lib"];

  for (const dir of systemDirs) {
    if (existsSync(dir)) {
      args.push("--ro-bind", dir, dir);
    }
  }

  if (existsSync("/lib64")) {
    args.push("--ro-bind", "/lib64", "/lib64");
  }

  for (const tool of binaries) {
    const toolPath = locate(tool);

    if (toolPath === undefined) {
      warning({ tool }, "Couldn't locate required tool");
      return false;
    }

    debug({ tool, toolPath }, "Tool available");
  }

  return true;
}

async function buildBwrap(binaries: string[], agentSlug: string): Promise<string[] | undefined> {
  const home = process.env.HOME;

  if (home === undefined) {
    warning("Could not locate $HOME");
    return undefined;
  }

  debug({ binaries }, "Building bwrap sandbox");

  const args = buildCommonArgs(home, agentSlug);

  addEtcBindings(args);
  addSslCertificates(args);

  const envPath = join(home, ".cireilclaw", "agents", agentSlug, "workspace", ".env");
  const extraVars = parseEnvFile(envPath);

  if (extraVars.length > 0) {
    debug({ count: extraVars.length, envPath }, "Loaded environment variables from .env file");
  }

  const isNixOS = detectNixOS();
  let success = false;

  if (isNixOS) {
    success = await buildNixBindings(args, binaries);
    addEnvironmentVars(args, "/bin", extraVars);
  } else {
    success = buildGenericLinuxBindings(args, binaries);
    addEnvironmentVars(args, "/usr/bin:/bin:/usr/local/bin", extraVars);
  }

  if (!success) {
    warning("Failed to build sandbox bindings");
    return undefined;
  }

  args.push("--chdir", "/workspace");

  return args;
}

async function runInSandbox(
  bwrapArgs: string[],
  commandPath: string,
  cmdArgs: string[],
  timeout: number,
): Promise<ExecOutput> {
  const prom = new Promise<ExecOutput>((resolve) => {
    const proc = spawn("bwrap", [...bwrapArgs.slice(1), commandPath, ...cmdArgs], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });

    const timeoutId = setTimeout(() => {
      proc.kill("SIGKILL");
    }, timeout);

    proc.on("close", (code) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeoutId);

      if (code === null) {
        resolve({
          exitCode: -1,
          stderr: `Command timed out after ${timeout}ms`,
          stdout,
          type: "output",
        });
        return;
      }

      resolve({
        exitCode: code,
        stderr,
        stdout,
        type: "output",
      });
    });

    proc.on("error", (err) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeoutId);

      resolve({
        exitCode: 1,
        stderr: err.message,
        stdout,
        type: "output",
      });
    });
  });

  const result = await prom;

  return result;
}

const SHELL_METACHAR_PATTERN = /[\s"'|&;$`\\]/;

async function exec(cfg: ExecConfig): Promise<ExecResult> {
  const { binaries, command, args, timeout, agentSlug } = cfg;

  // Reject any command with shell metacharacters or spaces
  if (SHELL_METACHAR_PATTERN.test(command)) {
    return {
      error: `Command '${command}' contains invalid characters. Use 'args' for arguments.`,
      type: "error",
    };
  }

  if (!binaries.includes(command)) {
    return {
      error: `Command '${command}' is not in the allowed binaries list.`,
      type: "error",
    };
  }

  const bwrap = await buildBwrap(binaries, agentSlug);

  if (bwrap === undefined) {
    return {
      error: "Failed to build bubblewrap sandbox, cannot execute.",
      type: "error",
    };
  }

  const isNixOS = detectNixOS();
  const commandPath = isNixOS ? `/bin/${command}` : (locate(command) ?? `/usr/bin/${command}`);

  return runInSandbox(bwrap, commandPath, args ?? [], timeout);
}

export { buildBwrap, exec, locate };
export type { ExecConfig, ExecError, ExecOutput, ExecResult };
