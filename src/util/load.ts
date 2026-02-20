import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { format, join } from "node:path";

import type { MemoryBlock } from "$/engine/block.js";
import colors from "$/output/colors.js";
import { root } from "$/util/paths.js";
import { parse } from "smol-toml";
import * as vb from "valibot";

type Frontmatter = Omit<MemoryBlock, "content" | "label" | "metadata">;

const labels = ["person", "identity", "long-term", "soul", "style-notes"] as const;
type BlockLabel = (typeof labels)[number];

async function loadBlocks(slug: string): Promise<Record<BlockLabel, MemoryBlock>> {
  const rootPath = join(root(), "agents", slug, "blocks");

  const files = new Map<BlockLabel, MemoryBlock>();

  for (const label of labels) {
    const it = format({
      dir: rootPath,
      ext: ".md",
      name: label,
    });

    if (existsSync(it)) {
      const content = await readFile(it, { encoding: "utf8" });

      if (content.indexOf("+++", 0) !== 0) {
        throw new Error(
          `Base file ${colors.keyword(label)} at path ${colors.path(it)} has an invalid frontmatter (expected TOML, but file does not start with '${colors.keyword("+++")}')`,
        );
      }

      const ending = content.indexOf("+++", 2);
      if (ending === -1) {
        throw new Error(
          `Base file ${colors.keyword(label)} at path ${colors.path(it)} has an invalid frontmatter (expected closing '${colors.keyword("+++")}', but none found)`,
        );
      }

      const tomlData = content.slice(3, ending);

      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const frontmatter = parse(tomlData) as Frontmatter;

      files.set(label, {
        content,
        description: frontmatter.description,
        filePath: `/blocks/${label}.md`,
        label,
        metadata: {
          chars_current: content.length - tomlData.length - 6, // `+++`s
        },
      });
    } else {
      throw new Error(
        `Missing required base file ${colors.keyword(label)} at path ${colors.path(it)}`,
      );
    }
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return Object.fromEntries(files.entries()) as Record<BlockLabel, MemoryBlock>;
}

async function loadBaseInstructions(slug: string): Promise<string> {
  const rootPath = join(root(), "agents", slug);

  const it = format({
    dir: rootPath,
    ext: ".md",
    name: "core",
  });

  if (existsSync(it)) {
    const content = await readFile(it, { encoding: "utf8" });

    return content;
  }

  throw new Error(
    `Missing required base file ${colors.keyword("core")} at path ${colors.path(it)}`,
  );
}

interface Skill {
  slug: string;
  summary: string;
  whenToUse: string;
}

const FrontmatterSchema = vb.strictObject({
  summary: vb.pipe(vb.string(), vb.nonEmpty()),
  whenToUse: vb.pipe(vb.string(), vb.nonEmpty()),
});

async function loadSkills(agentSlug: string): Promise<Skill[]> {
  const skillsPath = join(root(), "agents", agentSlug, "skills");

  if (!existsSync(skillsPath)) {
    return [];
  }

  const entries = await readdir(skillsPath);
  const skills: Skill[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".md")) {
      continue;
    }

    const slug = entry.slice(0, -3);
    const filePath = join(skillsPath, entry);
    const content = await readFile(filePath, { encoding: "utf8" });

    if (content.indexOf("+++", 0) !== 0) {
      throw new Error(
        `Skill file ${colors.keyword(slug)} at path ${colors.path(filePath)} has an invalid frontmatter (expected TOML, but file does not start with '${colors.keyword("+++")}')`,
      );
    }

    const ending = content.indexOf("+++", 3);
    if (ending === -1) {
      throw new Error(
        `Skill file ${colors.keyword(slug)} at path ${colors.path(filePath)} has an invalid frontmatter (expected closing '${colors.keyword("+++")}', but none found)`,
      );
    }

    const tomlData = content.slice(3, ending);
    const tomlObj = parse(tomlData);
    const frontmatter = vb.parse(FrontmatterSchema, tomlObj);

    skills.push({
      slug,
      summary: frontmatter.summary,
      whenToUse: frontmatter.whenToUse,
    });
  }

  return skills;
}

export type { Frontmatter, BlockLabel, Skill };
export { labels as blockLabels, loadBlocks, loadBaseInstructions, loadSkills };
