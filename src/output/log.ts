import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

import color from "$/output/colors.js";

type Level = "error" | "warning" | "info" | "debug";

interface LogConfig {
  level: Level;
}

const config: LogConfig = { level: "debug" };

const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_BACKUPS = 5;

// oxlint-disable-next-line init-declarations
let _fd: number | undefined;
// oxlint-disable-next-line init-declarations
let _filePath: string | undefined;
let _bytesWritten = 0;

// oxlint-disable-next-line no-control-regex
const ANSI_RE = /\u001B\[[0-9;]*m/g;
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

function rotate(filePath: string): void {
  // Shift backups: .4 → .5, .3 → .4, ..., .1 → .2
  for (let idx = MAX_BACKUPS - 1; idx >= 1; idx--) {
    const from = `${filePath}.${idx}`;
    const to = `${filePath}.${idx + 1}`;
    if (existsSync(from)) {
      renameSync(from, to);
    }
  }
  // Close current fd, rename current log → .1, open fresh file
  if (_fd !== undefined) {
    closeSync(_fd);
    _fd = undefined;
  }
  if (existsSync(filePath)) {
    renameSync(filePath, `${filePath}.1`);
  }
  _fd = openSync(filePath, "a");
  _bytesWritten = 0;
}

function writeToFile(level: Level, data: unknown[]): void {
  if (_fd === undefined || _filePath === undefined) {
    return;
  }
  try {
    const line = `${JSON.stringify(serializeArgs(level, data))}\n`;
    appendFileSync(_fd, line);
    _bytesWritten += Buffer.byteLength(line);
    if (_bytesWritten >= MAX_BYTES) {
      rotate(_filePath);
    }
  } catch {
    // Never let a log write failure crash the application.
  }
}

const LEVEL_RANK: Record<Level, number> = { debug: 0, error: 3, info: 1, warning: 2 };

function isEnabled(callLevel: Level): boolean {
  return LEVEL_RANK[callLevel] >= LEVEL_RANK[config.level];
}

function setLogFile(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  _filePath = filePath;
  _fd = openSync(filePath, "a");
  // Seed _bytesWritten from any pre-existing file size so rotation triggers correctly.
  try {
    _bytesWritten = statSync(filePath).size;
  } catch {
    _bytesWritten = 0;
  }
}

function debug(...data: unknown[]): void {
  if (isEnabled("debug")) {
    console.debug(color.debug("[DEBUG]"), ...data);
    writeToFile("debug", data);
  }
}

function info(...data: unknown[]): void {
  if (isEnabled("info")) {
    console.info(color.info("[ INFO]"), ...data);
    writeToFile("info", data);
  }
}

function warning(...data: unknown[]): void {
  if (isEnabled("warning")) {
    console.warn(color.warning("[ WARN]"), ...data);
    writeToFile("warning", data);
  }
}

function error(...data: unknown[]): void {
  console.error(color.error("[ERROR]"), ...data);
  writeToFile("error", data);
}

export { config, debug, error, info, setLogFile, warning };
