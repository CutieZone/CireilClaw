import { runCommand } from "$/cli/run-command.js";
import { buildApplication, buildRouteMap } from "@stricli/core";

const routes = buildRouteMap({
  defaultCommand: "run",
  docs: {
    brief: "awawa",
  },
  routes: {
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
