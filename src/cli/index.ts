import { runCommand } from "$/cli/run-command.js";
import { buildApplication, buildRouteMap } from "@stricli/core";

import { clearCommand } from "./clear-command.js";
import { initCommand } from "./init-command.js";

const routes = buildRouteMap({
  defaultCommand: "run",
  docs: {
    brief: "awawa",
  },
  routes: {
    clear: clearCommand,
    init: initCommand,
    run: runCommand,
  },
});

const application = buildApplication(routes, {
  completion: {
    includeAliases: true,
  },
  name: "cireilclaw",
});

export { application };
