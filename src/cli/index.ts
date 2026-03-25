import { repairImagesCommand } from "$/cli/repair-images-command.js";
import { runCommand } from "$/cli/run-command.js";
import { tuiCommand } from "$/cli/tui-command.js";
import { buildApplication, buildRouteMap } from "@stricli/core";

import { clearCommand } from "./clear-command.js";
import { initCommand } from "./init-command.js";
import { migrateCommand } from "./migrate-command.js";
const routes = buildRouteMap({
  defaultCommand: "run",
  docs: {
    brief: "awawa",
  },
  routes: {
    clear: clearCommand,
    init: initCommand,
    migrate: migrateCommand,
    "repair-images": repairImagesCommand,
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
