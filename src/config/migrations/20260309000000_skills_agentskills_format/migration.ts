import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ConfigMigration } from "$/config/migrations/index.js";
import { parse } from "smol-toml";

function yamlQuote(str: string): string {
  return `"${str.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
}

const migration: ConfigMigration = {
  description:
    "Convert flat skill .md files to agentskills.io directory format (slug/SKILL.md with YAML frontmatter)",
  id: "20260309000000_skills_agentskills_format",

  async migrateAgent(_agentSlug, agentPath, context) {
    const skillsPath = join(agentPath, "skills");

    if (!existsSync(skillsPath)) {
      return;
    }

    const entries = await readdir(skillsPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      const slug = entry.name.slice(0, -3);
      const flatPath = join(skillsPath, entry.name);
      const content = await readFile(flatPath, "utf8");

      // Parse TOML +++ frontmatter
      if (!content.startsWith("+++")) {
        continue;
      }
      const ending = content.indexOf("+++", 3);
      if (ending === -1) {
        continue;
      }

      // Backup the original file before modification
      await context.backupFile(flatPath);

      const tomlData = content.slice(3, ending);
      const frontmatter = parse(tomlData) as { summary?: string; whenToUse?: string };
      const body = content.slice(ending + 3).trimStart();

      const summary = typeof frontmatter.summary === "string" ? frontmatter.summary : "";
      const whenToUse = typeof frontmatter.whenToUse === "string" ? frontmatter.whenToUse : "";
      const description = [summary, whenToUse].filter(Boolean).join(" ");

      const yaml = [
        "---",
        `name: ${yamlQuote(slug)}`,
        `description: ${yamlQuote(description)}`,
        "---",
        "",
      ].join("\n");

      const dirPath = join(skillsPath, slug);
      await mkdir(dirPath, { recursive: true });
      await writeFile(join(dirPath, "SKILL.md"), yaml + body, "utf8");
      await rm(flatPath);
    }
  },

  targets: [],

  transform(data) {
    return data;
  },
};

export { migration };
