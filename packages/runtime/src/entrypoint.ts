import { run } from "@stricli/core";

import { application } from "./cli/index.js";

await run(application, process.argv.slice(2), { process });
