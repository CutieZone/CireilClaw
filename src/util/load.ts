import type { MemoryBlock } from "$/engine/block.js";

import colors from "$/output/colors.js";
import { root } from "$/util/paths.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { format, join } from "node:path";
import { parse } from "smol-toml";

type Frontmatter = Omit<MemoryBlock, "content" | "label">;

const labels = ["core", "person", "identity", "long-term", "soul"] as const;
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
        filePath: `/blocks/${label}`,
        label,
        metadata: frontmatter.metadata,
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

export type { Frontmatter, BlockLabel };
export { loadBlocks, loadBaseInstructions };
