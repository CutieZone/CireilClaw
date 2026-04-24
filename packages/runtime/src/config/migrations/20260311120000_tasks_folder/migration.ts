import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

import type { ConfigMigration } from "#config/migrations/index.js";

const migration: ConfigMigration = {
  description: "Move HEARTBEAT.md from workspace/ to tasks/ directory",
  id: "20260311120000_tasks_folder",

  async migrateAgent(_agentSlug, agentPath, context) {
    const oldPath = join(agentPath, "workspace", "HEARTBEAT.md");
    if (!existsSync(oldPath)) {
      return;
    }

    // Backup before moving
    await context.backupFile(oldPath);

    const tasksDir = join(agentPath, "tasks");
    await mkdir(tasksDir, { recursive: true });

    const newPath = join(tasksDir, "HEARTBEAT.md");
    await rename(oldPath, newPath);
  },

  targets: [],

  transform(data) {
    return data;
  },
};

export { migration };
