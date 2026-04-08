// oxlint-disable promise/no-multiple-resolved
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { parse, isAbsolute, join, resolve as resolvePath } from "node:path";

import { debug, warning } from "$/output/log.js";

import { root } from "./paths.js";

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

  const pathEnv = pathEnvOverride ?? (process.env["PATH"] ?? "").split(":");

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
  hostEnvPassthrough: string[];
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
    "--bind",
    join(home, ".cireilclaw", "agents", agentSlug, "tasks"),
    "/tasks",
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

interface EnvParseError {
  type: "error";
  message: string;
  hint?: string;
}

// Matches $VAR, ${VAR}, or ${VAR:-default}
const ENV_VAR_PATTERN = /\$\{(\w+)(?::-([^}]*))?\}|\$(\w+)/g;

class EnvResolutionError extends Error {
  override name = "EnvResolutionError";
}

function isEnvParseError(value: string | EnvParseError): value is EnvParseError {
  return typeof value !== "string";
}

function resolveEnvValue(
  rawValue: string,
  fileVars: Map<string, string>,
  resolutionStack: Set<string>,
): string | EnvParseError {
  try {
    return rawValue.replace(
      ENV_VAR_PATTERN,
      (
        match,
        braced: string | undefined,
        defaultVal: string | undefined,
        bare: string | undefined,
      ) => {
        const key: string | undefined = braced ?? bare;

        if (key === undefined) {
          return match;
        }

        if (resolutionStack.has(key)) {
          throw new EnvResolutionError(`Circular reference to '${key}'`);
        }

        // Look up in order: file vars (already resolved) → host env
        const fromFile = fileVars.get(key);
        const fromHost = process.env[key];

        if (fromFile !== undefined) {
          resolutionStack.add(key);
          const resolved = resolveEnvValue(fromFile, fileVars, resolutionStack);
          resolutionStack.delete(key);

          if (isEnvParseError(resolved)) {
            throw new EnvResolutionError(resolved.message);
          }
          return resolved;
        }

        if (fromHost !== undefined) {
          return fromHost;
        }

        // Not found — use default if provided
        if (defaultVal !== undefined) {
          return defaultVal;
        }

        throw new EnvResolutionError(`Undefined variable '${key}'`);
      },
    );
  } catch (error) {
    const message = error instanceof EnvResolutionError ? error.message : String(error);
    return { message, type: "error" };
  }
}

interface RawEnvLine {
  key: string;
  lineNumber: number;
  value: string;
}

function parseEnvFile(envPath: string): EnvVar[] | EnvParseError {
  if (!existsSync(envPath)) {
    return [];
  }

  const content = readFileSync(envPath, "utf8");
  const rawVars: RawEnvLine[] = [];
  const resolvedVars = new Map<string, string>();

  const lines = content.split("\n");

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (line === undefined) {
      continue;
    }

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

    rawVars.push({ key, lineNumber: lineIndex + 1, value });
  }

  // Second pass: resolve values
  for (const { key, lineNumber, value: rawValue } of rawVars) {
    const resolved = resolveEnvValue(rawValue, resolvedVars, new Set());

    if (typeof resolved !== "string") {
      return {
        hint: `Edit the .env file at ${envPath} to fix the variable reference.`,
        message: `Line ${lineNumber}: ${resolved.message}`,
        type: "error",
      };
    }

    resolvedVars.set(key, resolved);
  }

  // Return resolved vars
  return rawVars.map(({ key }) => ({
    key,
    value: resolvedVars.get(key) ?? "",
  }));
}

function addEnvironmentVars(
  args: string[],
  pathValue: string,
  extraVars?: EnvVar[],
  passthroughVars?: string[],
): void {
  args.push("--clearenv");

  const defaultVars: EnvVar[] = [
    { key: "PATH", value: pathValue },
    { key: "HOME", value: "/workspace" },
    { key: "LANG", value: "C.UTF-8" },
    { key: "LC_ALL", value: "C.UTF-8" },
  ];

  // Read passthrough vars from host environment
  const hostVars: EnvVar[] = [];
  for (const key of passthroughVars ?? []) {
    const value = process.env[key];
    if (value !== undefined) {
      hostVars.push({ key, value });
    }
  }

  const allVars = extraVars
    ? [...defaultVars, ...extraVars, ...hostVars]
    : [...defaultVars, ...hostVars];

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

  // Bind /usr/bin/env for shebang compatibility — many scripts hardcode this path.
  const envBinPath = locate("env", ["/run/current-system/sw/bin"]);
  if (envBinPath !== undefined) {
    const envResult = await queryNixStore(envBinPath);
    if (envResult.success) {
      for (const path of envResult.requisites) {
        if (!uniquePaths.has(path)) {
          args.push("--ro-bind", path, path);
        }
      }
      args.push("--dir", "/usr");
      args.push("--dir", "/usr/bin");
      args.push("--symlink", realpathSync(envBinPath), "/usr/bin/env");
    }
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

  // Dynamic linker configuration for finding shared libraries
  const ldConfigFiles = ["/etc/ld.so.cache", "/etc/ld.so.conf"];
  for (const file of ldConfigFiles) {
    if (existsSync(file)) {
      args.push("--ro-bind", file, file);
    }
  }

  if (existsSync("/etc/ld.so.conf.d")) {
    args.push("--ro-bind", "/etc/ld.so.conf.d", "/etc/ld.so.conf.d");
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

interface BwrapSuccess {
  type: "success";
  args: string[];
}

interface BwrapError {
  type: "error";
  message: string;
  hint?: string;
}

type BwrapResult = BwrapSuccess | BwrapError;

async function buildBwrap(
  binaries: string[],
  hostEnvPassthrough: string[],
  agentSlug: string,
): Promise<BwrapResult> {
  const home = process.env["HOME"];

  if (home === undefined) {
    warning("Could not locate $HOME");
    return { message: "Could not locate $HOME environment variable", type: "error" };
  }

  debug({ binaries }, "Building bwrap sandbox");

  const args = buildCommonArgs(home, agentSlug);

  addEtcBindings(args);
  addSslCertificates(args);

  const envPath = join(root(), "agents", agentSlug, "workspace", ".env");
  const envResult = parseEnvFile(envPath);

  if (!Array.isArray(envResult)) {
    return envResult;
  }

  if (envResult.length > 0) {
    debug({ count: envResult.length, envPath }, "Loaded environment variables from .env file");
  }

  const isNixOS = detectNixOS();
  let success = false;

  if (isNixOS) {
    success = await buildNixBindings(args, binaries);
    addEnvironmentVars(args, "/bin", envResult, hostEnvPassthrough);
  } else {
    success = buildGenericLinuxBindings(args, binaries);
    addEnvironmentVars(args, "/usr/bin:/bin:/usr/local/bin", envResult, hostEnvPassthrough);
  }

  if (!success) {
    warning("Failed to build sandbox bindings");
    return { message: "Failed to build sandbox bindings", type: "error" };
  }

  args.push("--chdir", "/workspace");

  return { args, type: "success" };
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
  const { binaries, command, args, hostEnvPassthrough, timeout, agentSlug } = cfg;

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

  const bwrap = await buildBwrap(binaries, hostEnvPassthrough, agentSlug);

  if (bwrap.type === "error") {
    const error =
      bwrap.hint !== undefined && bwrap.hint.length > 0
        ? `${bwrap.message}\n\nHint: ${bwrap.hint}`
        : bwrap.message;
    return { error, type: "error" };
  }

  const isNixOS = detectNixOS();
  const commandPath = isNixOS ? `/bin/${command}` : (locate(command) ?? `/usr/bin/${command}`);

  return runInSandbox(bwrap.args, commandPath, args ?? [], timeout);
}

export { buildBwrap, exec, locate, parseEnvFile, SHELL_METACHAR_PATTERN };
export type { ExecConfig, ExecError, ExecOutput, ExecResult };
