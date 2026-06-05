import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
} from "node:fs";
import path from "node:path";

import color from "#output/colors.js";

type Level = "error" | "warning" | "info" | "debug";

interface LogConfig {
  level: Level;
}

const config: LogConfig = { level: "debug" };

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_BACKUPS = 5;

let fd: number | undefined = undefined;
let filePath: string | undefined = undefined;
let bytesWritten = 0;

// oxlint-disable-next-line no-control-regex
const ANSI_RE = /\u001B\[[0-9;]*m/gu;
function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

function serializeArgs(level: Level, data: unknown[]): Record<string, unknown> {
  let msg = "";
  const extra: Record<string, unknown> = {};

  for (const item of data) {
    if (typeof item === "string") {
      msg = msg === "" ? stripAnsi(item) : `${msg} ${stripAnsi(item)}`;
    } else if (item instanceof Error) {
      extra["error"] = item.message;
      if (item.stack !== undefined) {
        extra["stack"] = item.stack;
      }
    } else if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      Object.assign(extra, item);
    } else if (item !== null && item !== undefined) {
      msg = `${msg} ${JSON.stringify(item)}`;
    }
  }

  return { level, msg, ts: new Date().toISOString(), ...extra };
}

function rotate(filePth: string): void {
  for (let idx = MAX_BACKUPS - 1; idx >= 1; idx--) {
    const from = `${filePth}.${idx}`;
    const to = `${filePth}.${idx + 1}`;
    if (existsSync(from)) {
      renameSync(from, to);
    }
  }
  if (fd !== undefined) {
    closeSync(fd);
    fd = undefined;
  }
  if (existsSync(filePth)) {
    renameSync(filePth, `${filePth}.1`);
  }
  fd = openSync(filePth, "a");
  bytesWritten = 0;
}

function writeToFile(level: Level, data: unknown[]): void {
  if (fd === undefined || filePath === undefined) {
    return;
  }
  try {
    const line = `${JSON.stringify(serializeArgs(level, data))}\n`;
    appendFileSync(fd, line);
    bytesWritten += Buffer.byteLength(line);
    if (bytesWritten >= MAX_BYTES) {
      rotate(filePath);
    }
  } catch {
    // Never let a log write failure crash the application.
  }
}

const LEVEL_RANK: Record<Level, number> = { debug: 0, error: 3, info: 1, warning: 2 };

function isEnabled(callLevel: Level): boolean {
  return LEVEL_RANK[callLevel] >= LEVEL_RANK[config.level];
}

function setLogFile(filePth: string): void {
  mkdirSync(path.dirname(filePth), { recursive: true });
  if (fd !== undefined) {
    try {
      closeSync(fd);
    } catch {
      // Ignore close errors on rotation/reconfiguration.
    }
    fd = undefined;
  }
  filePath = filePth;
  fd = openSync(filePth, "a");
  // Seed bytesWritten from any pre-existing file size so rotation triggers correctly.
  try {
    bytesWritten = statSync(filePth).size;
  } catch {
    bytesWritten = 0;
  }
}

function debug(...data: unknown[]): void {
  writeToFile("debug", data);
  if (isEnabled("debug")) {
    console.debug(color.debug("[DEBUG]"), ...data);
  }
}

function info(...data: unknown[]): void {
  writeToFile("info", data);
  if (isEnabled("info")) {
    console.info(color.info("[ INFO]"), ...data);
  }
}

function warning(...data: unknown[]): void {
  writeToFile("warning", data);
  if (isEnabled("warning")) {
    console.warn(color.warning("[ WARN]"), ...data);
  }
}

function error(...data: unknown[]): void {
  writeToFile("error", data);
  console.error(color.error("[ERROR]"), ...data);
}

export { config, debug, error, info, setLogFile, warning };
