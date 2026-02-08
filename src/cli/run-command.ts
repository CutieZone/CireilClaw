import color from "$/output/colors.js";
import { config, info, warning } from "$/output/log.js";
import ora from "ora";

interface Flags {
  logLevel: "error" | "warning" | "info" | "debug";
}

export async function run(flags: Flags): Promise<void> {
  config.level = flags.logLevel;

  info("Initializing", color.keyword("cireilclaw"));
  warning("We're not", color.number("100%"), "sure that this works.");
}
