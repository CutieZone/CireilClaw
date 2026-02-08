interface LogConfig {
  level: "error" | "warning" | "info" | "debug";
}

const config: LogConfig = {
  level: "debug",
};

function debug(...data: unknown[]): void {
  if (config.level === "debug") {
    console.debug(...data);
  }
}

function info(...data: unknown[]): void {
  if (config.level === "debug" || config.level === "info") {
    console.info(...data);
  }
}

function warning(...data: unknown[]): void {
  if (config.level === "debug" || config.level === "info" || config.level === "warning") {
    console.warn(...data);
  }
}

function error(...data: unknown[]): void {
  console.error(...data);
}

export { debug, info, warning, error, config };
