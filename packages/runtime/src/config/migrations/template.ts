import type { ConfigMigration } from "$/config/migrations/index.js";

// Guard: This is a template file and should never be executed
throw new Error(
  "Cannot run template migration. Copy this file to a new directory with a proper timestamp ID (e.g., 20260305120000_my_migration) and update the id field.",
);

// oxlint-disable-next-line no-unreachable
const migration: ConfigMigration = {
  description: "Brief description of what this migration does",
  id: "20260305000000_descriptive_name",
  targets: ["tools.toml"], // or ["engine.toml", "heartbeat.toml", etc.]

  transform(_data, _context) {
    // data: parsed TOML object (mutate and return)
    // context: { agentSlug?, configType, configPath, backupFile }

    // Example: rename a tool
    // if (_data["old-tool-name"] !== undefined) {
    //   _data["new-tool-name"] = _data["old-tool-name"];
    //   delete _data["old-tool-name"];
    // }

    // Example: add default value
    // if (_data["newField"] === undefined) {
    //   _data["newField"] = "defaultValue";
    // }

    // Example: rename field
    // if (_data["checkInterval"] !== undefined) {
    //   _data["interval"] = _data["checkInterval"];
    //   delete _data["checkInterval"];
    // }

    // Example: agent-specific transformations
    // if (_context.agentSlug === "special-agent") {
    //   _data["specialFlag"] = true;
    // }

    return _data;
  },

  // Optional: run arbitrary filesystem operations per agent after TOML transforms
  // async migrateAgent(agentSlug, agentPath, context) {
  //   // agentSlug: the agent's identifier (e.g., "my-agent")
  //   // agentPath: full path to the agent directory
  //   // context.backupFile(filePath): backup a file before modifying/deleting
  //
  //   // IMPORTANT: Always backup files before modifying or deleting them
  //   // await context.backupFile(pathToFile);
  //
  //   // Example: move a file
  //   // const oldPath = join(agentPath, "workspace", "HEARTBEAT.md");
  //   // if (existsSync(oldPath)) {
  //   //   await context.backupFile(oldPath);
  //   //   await rename(oldPath, join(agentPath, "tasks", "HEARTBEAT.md"));
  //   // }
  // },
};

export { migration };
