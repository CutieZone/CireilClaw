// oxlint-disable typescript/no-empty-object-type
import colors from "$/output/colors.js";
import { warning } from "$/output/log.js";
import { root } from "$/util/paths.js";
import { confirm } from "@inquirer/prompts";
import { buildCommand } from "@stricli/core";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";

// oxlint-disable-next-line typescript/no-empty-interface
interface Flags {}

async function renameOld(): Promise<void> {
  const base = root();

  let randoms = randomBytes(8).toString("hex");

  while (existsSync(`${base}_${randoms}`)) {
    randoms = randomBytes(8).toString("hex");
  }

  await rename(base, `${base}.${randoms}`);
  warning("Moved", colors.path(base));
  warning("To", colors.path(`${base}_${randoms}`));
}

async function run(_flags: Flags): Promise<void> {
  const base = root();

  if (existsSync(base)) {
    warning("The path", colors.path(base), "already exists. It may contain sensitive data.");
    warning(
      "If you say 'yes' to overwrite, we will rename the existing directory to end with a random string of characters.",
    );
    const check = await confirm({ default: false, message: `Overwrite?` });

    if (check) {
      await renameOld();
    }
  }
}

export const initCommand = buildCommand({
  docs: {
    brief: "bwbwb",
  },
  func: run,
  parameters: {},
});
