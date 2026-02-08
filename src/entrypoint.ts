import { application } from "$/cli/index.js";
import { run } from "@stricli/core";

await run(application, process.argv.slice(2), { process });
