import { runMigrations } from "$/config/migrations/runner.js";
import colors from "$/output/colors.js";
import { info } from "$/output/log.js";
import { buildCommand } from "@stricli/core";

interface Flags {
  dryRun: boolean;
}

async function run(flags: Flags): Promise<void> {
  if (flags.dryRun) {
    info("Dry run mode - no migrations will be applied");
    info("Use", colors.keyword("cireilclaw migrate"), "to apply pending migrations");
    // In a real dry run, we'd show what would happen without applying
    // For now, this is just informational
    return;
  }

  await runMigrations();
  info("Migrations complete");
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
