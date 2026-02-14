import { watcher } from "$/config/index.js";
import color from "$/output/colors.js";
import { config, debug, error, info, warning } from "$/output/log.js";
import { buildCommand } from "@stricli/core";
import ora from "ora";

interface Flags {
  logLevel: "error" | "warning" | "info" | "debug";
}

async function run(flags: Flags): Promise<void> {
  config.level = flags.logLevel;

  debug("Beep boop~");
  info("Initializing", color.keyword("cireilclaw"));
  warning("We're not", color.number("100%"), "sure that this works.");
  error("Cuteness overload");

  const sc = new AbortController();

  const watchers = await watcher(sc.signal);

  const spin = ora({
    discardStdin: false,
    text: "Waiting for file changes...",
  });

  process.once("SIGINT", () => {
    spin.succeed("Done listening~");
    sc.abort("SIGINT");
    process.exit(0);
  });

  spin.start();

  for await (const message of watchers) {
    info("Got change", color.keyword(message.eventType), "for path", color.path(message.filename));
  }
}

export const runCommand = buildCommand({
  docs: {
    brief: "bwbwb",
  },
  func: run,
  parameters: {
    flags: {
      logLevel: {
        brief: "Which log level to use",
        default: "debug",
        kind: "enum",
        values: ["error", "warning", "info", "debug"],
      },
    },
  },
});
