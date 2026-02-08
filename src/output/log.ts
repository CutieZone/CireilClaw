import color from "$/output/colors.js";

interface LogConfig {
  level: "error" | "warning" | "info" | "debug";
}

const config: LogConfig = {
  level: "debug",
};

function debug(...data: unknown[]): void {
  if (config.level === "debug") {
    console.debug(color.debug("[DEBUG]"), ...data);
  }
}

function info(...data: unknown[]): void {
  if (config.level === "debug" || config.level === "info") {
    console.info(color.info("[ INFO]"), ...data);
  }
}

function warning(...data: unknown[]): void {
  if (config.level === "debug" || config.level === "info" || config.level === "warning") {
    console.warn(color.warning("[ WARN]"), ...data);
  }
}

function error(...data: unknown[]): void {
  console.error(color.error("[ERROR]"), ...data);
}

export { debug, info, warning, error, config };
