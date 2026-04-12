import type { ConfigMigration } from "$/config/migrations/index.js";

const migration: ConfigMigration = {
  description: "Rename discord-download-attachments to download-attachments",
  id: "20260305000000_tool_rename_discord_attachments",
  targets: ["tools.toml"],

  transform(data) {
    // Rename tool in tools.toml
    if (data["discord-download-attachments"] !== undefined) {
      data["download-attachments"] = data["discord-download-attachments"];
      delete data["discord-download-attachments"];
    }

    return data;
  },
};

export { migration };
