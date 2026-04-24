import { buildCommand } from "@stricli/core";

import { runMigrations } from "#config/migrations/runner.js";
import colors from "#output/colors.js";
import { info } from "#output/log.js";

interface Flags {
  dryRun: boolean;
}

async function run(flags: Flags): Promise<void> {
  const res = await runMigrations(flags.dryRun);

  if (flags.dryRun) {
    if (res > 0) {
      info(`Run ${colors.keyword("cireilclaw migrate")} to apply these migrations.`);
    } else {
      info("No pending migrations.");
    }
  } else if (res > 0) {
    info("Migrations complete");
  } else {
    info("There were no migrations to apply.");
  }
}

export const migrateCommand = buildCommand({
  docs: {
    brief: "Run configuration migrations without starting the harness",
  },
  func: run,
  parameters: {
    flags: {
      dryRun: {
        brief: "Show pending migrations without applying them",
        default: false,
        kind: "boolean",
      },
    },
  },
});
