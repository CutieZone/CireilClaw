import { buildApplication, buildCommand, buildRouteMap } from "@stricli/core";

const runCommand = buildCommand({
  docs: {
    brief: "bwbwb",
  },
  loader: async () => {
    const run = await import("$/cli/run-command.js");
    return run.run;
  },
  parameters: {
    flags: {
      logLevel: {
        brief: "",
        default: "debug",
        kind: "enum",
        values: ["error", "warning", "info", "debug"],
      },
    },
  },
});

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
