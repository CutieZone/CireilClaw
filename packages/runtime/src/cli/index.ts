import { buildApplication, buildRouteMap } from "@stricli/core";

import { clearCommand } from "#cli/clear-command.js";
import { codexCommand } from "#cli/codex-command.js";
import { initCommand } from "#cli/init-command.js";
import { migrateCommand } from "#cli/migrate-command.js";
import { repairCommand } from "#cli/repair-command.js";
import { runCommand } from "#cli/run-command.js";
import { tuiCommand } from "#cli/tui-command.js";

const routes = buildRouteMap({
  defaultCommand: "run",
  docs: {
    brief: "awawa",
  },
  routes: {
    clear: clearCommand,
    codex: codexCommand,
    init: initCommand,
    migrate: migrateCommand,
    repair: repairCommand,
    run: runCommand,
    tui: tuiCommand,
  },
});

const application = buildApplication(routes, {
  completion: {
    includeAliases: true,
  },
  name: "cireilclaw",
});

export { application };
