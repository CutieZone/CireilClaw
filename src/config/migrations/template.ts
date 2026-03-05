// oxlint-disable-next-line import/order
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

  // oxlint-disable-next-line arrow-body-style
  transform(_data, _context) {
    // data: parsed TOML object (mutate and return)
    // context: { agentSlug?, configType, configPath }

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
};

export { migration };
