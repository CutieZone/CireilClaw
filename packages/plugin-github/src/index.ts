import { definePlugin } from "@cireilclaw/sdk";

import { commentTools } from "./comments.js";
import { contentTools } from "./content.js";
import { issueTools } from "./issues.js";
import { prTools } from "./pulls.js";
import { repoTools } from "./repos.js";

// oxlint-disable-next-line import/no-default-export
export default definePlugin(() => ({
  name: "github",
  tools: {
    ...issueTools,
    ...prTools,
    ...commentTools,
    ...repoTools,
    ...contentTools,
  },
}));
