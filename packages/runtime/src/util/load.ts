import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "smol-toml";
import * as vb from "valibot";
import { parse as parseYaml } from "yaml";

import type { ConditionsConfig } from "#config/schemas/conditions.js";
import type { MemoryBlock } from "#engine/block.js";
import type { Session } from "#harness/session.js";
import colors from "#output/colors.js";
import { getMatchingBlockNames } from "#util/conditions.js";
import { root } from "#util/paths.js";

const BlockFrontmatterSchema = vb.object({
  description: vb.string(),
});

type Frontmatter = Omit<MemoryBlock, "content" | "label" | "metadata" | "filePath">;

function parseBlockFrontmatter(
  content: string,
  displayName: string,
  filePath: string,
  subject = "Base file",
): {
  body: string;
  frontmatter: Frontmatter;
} {
  if (content.indexOf("+++", 0) !== 0) {
    throw new Error(
      `${subject} ${colors.keyword(displayName)} at path ${colors.path(filePath)} has an invalid frontmatter (expected TOML, but file does not start with '${colors.keyword("+++")}')`,
    );
  }

  const ending = content.indexOf("+++", 3);
  if (ending === -1) {
    throw new Error(
      `${subject} ${colors.keyword(displayName)} at path ${colors.path(filePath)} has an invalid frontmatter (expected closing '${colors.keyword("+++")}', but none found)`,
    );
  }

  const tomlData = content.slice(3, ending);
  let bodyStart = ending + 3;
  if (content.startsWith("\r\n", bodyStart)) {
    bodyStart += 2;
  } else if (content.startsWith("\n", bodyStart)) {
    bodyStart += 1;
  }

  return {
    body: content.slice(bodyStart),
    frontmatter: vb.parse(BlockFrontmatterSchema, parse(tomlData)),
  };
}

const labels = ["soul", "identity", "person", "long-term", "style-notes"] as const;
type BlockLabel = (typeof labels)[number];

async function loadBlocks(slug: string): Promise<Record<BlockLabel, MemoryBlock>> {
  const rootPath = path.join(root(), "agents", slug, "blocks");

  const files = new Map<BlockLabel, MemoryBlock>();

  for (const label of labels) {
    const it = path.format({
      dir: rootPath,
      ext: ".md",
      name: label,
    });

    if (existsSync(it)) {
      const content = await readFile(it, { encoding: "utf8" });
      const { body, frontmatter } = parseBlockFrontmatter(content, label, it, "Base file");

      files.set(label, {
        content: body,
        description: frontmatter.description,
        filePath: `/blocks/${label}.md`,
        label,
        metadata: {
          chars_current: body.length,
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
  const rootPath = path.join(root(), "agents", slug);

  const it = path.format({
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
  description: string;
}

const FrontmatterSchema = vb.object({
  description: vb.pipe(vb.string(), vb.nonEmpty()),
  name: vb.pipe(vb.string(), vb.nonEmpty()),
});

async function loadSkills(agentSlug: string): Promise<Skill[]> {
  const skillsPath = path.join(root(), "agents", agentSlug, "skills");

  if (!existsSync(skillsPath)) {
    return [];
  }

  const entries = await readdir(skillsPath, { withFileTypes: true });
  const skills: Skill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const slug = entry.name;
    const filePath = path.join(skillsPath, slug, "SKILL.md");

    if (!existsSync(filePath)) {
      continue;
    }

    const content = await readFile(filePath, { encoding: "utf8" });

    if (!content.startsWith("---")) {
      throw new Error(
        `Skill file ${colors.keyword(slug)} at path ${colors.path(filePath)} has invalid frontmatter (expected YAML, file does not start with '${colors.keyword("---")}')`,
      );
    }

    const ending = content.indexOf("---", 3);
    if (ending === -1) {
      throw new Error(
        `Skill file ${colors.keyword(slug)} at path ${colors.path(filePath)} has invalid frontmatter (expected closing '${colors.keyword("---")}', but none found)`,
      );
    }

    const yamlData = content.slice(3, ending);
    const frontmatter = vb.parse(FrontmatterSchema, parseYaml(yamlData));

    skills.push({
      description: frontmatter.description,
      slug,
    });
  }

  return skills;
}

async function loadConditionalBlocks(
  agentSlug: string,
  conditions: ConditionsConfig,
  session: Session,
): Promise<MemoryBlock[]> {
  const matchingNames = getMatchingBlockNames(conditions.blocks, session);
  if (matchingNames.length === 0) {
    return [];
  }

  const conditionalPath = path.join(root(), "agents", agentSlug, "blocks", "conditional");
  if (!existsSync(conditionalPath)) {
    return [];
  }

  const blocks: MemoryBlock[] = [];

  for (const name of matchingNames) {
    const filePath = path.join(conditionalPath, `${name}.md`);

    if (!existsSync(filePath)) {
      continue;
    }

    const content = await readFile(filePath, { encoding: "utf8" });
    const { body, frontmatter } = parseBlockFrontmatter(
      content,
      name,
      filePath,
      "Conditional block",
    );

    blocks.push({
      content: body,
      description: frontmatter.description,
      filePath: `/blocks/conditional/${name}.md`,
      label: `conditional/${name}`,
      metadata: {
        chars_current: body.length,
      },
    });
  }

  return blocks;
}

export type { Frontmatter, BlockLabel, Skill };
export {
  labels as blockLabels,
  loadBlocks,
  loadBaseInstructions,
  loadSkills,
  loadConditionalBlocks,
};
