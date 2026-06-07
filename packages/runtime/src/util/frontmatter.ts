import { parse } from "smol-toml";
import * as vb from "valibot";
import { parse as parseYaml } from "yaml";

/**
 * Utility for preserving frontmatter in block/skill files during write and str-replace operations.
 *
 * Block files use TOML frontmatter delimited by `+++...+++`.
 * Skill files use YAML frontmatter delimited by `---...---`.
 * In both cases the frontmatter is REQUIRED — the loading code throws if it's missing or malformed.
 */

const BlockFrontmatterSchema = vb.object({
  description: vb.string(),
});

const SkillFrontmatterSchema = vb.object({
  description: vb.pipe(vb.string(), vb.nonEmpty()),
  name: vb.pipe(vb.string(), vb.nonEmpty()),
});

/**
 * Validates that the frontmatter in the given content string is parseable
 * (TOML for blocks, YAML for skills) and matches the expected Valibot schema.
 * Throws a descriptive Error on failure.
 */
function validateFrontmatter(content: string, isBlock: boolean): void {
  const delim = isBlock ? "+++" : "---";
  const schema = isBlock ? BlockFrontmatterSchema : SkillFrontmatterSchema;

  if (!content.startsWith(delim)) {
    throw new Error(`Invalid frontmatter: expected file to start with '${delim}'`);
  }

  const closingIdx = content.indexOf(delim, delim.length);
  if (closingIdx === -1) {
    throw new Error(`Invalid frontmatter: missing closing '${delim}'`);
  }

  const rawData = content.slice(delim.length, closingIdx);

  try {
    const parsed: unknown = isBlock ? parse(rawData) : parseYaml(rawData);
    vb.parse(schema, parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid frontmatter: ${message}`, { cause: error });
  }
}

/**
 * Returns true when a sandbox path refers to a file type that requires frontmatter.
 * Block files: /blocks/ (any .md)
 * Skill files: /skills/ (only SKILL.md)
 */
function requiresFrontmatter(sandboxPath: string): boolean {
  if (sandboxPath.startsWith("/blocks/")) {
    return true;
  }
  if (sandboxPath.startsWith("/skills/") && sandboxPath.endsWith("/SKILL.md")) {
    return true;
  }
  return false;
}

/**
 * Splits file content into frontmatter (delimiter + content + closing delimiter + trailing newline)
 * Returns undefined when the content doesn't have valid frontmatter for the file type.
 *
 * Matches the parsing logic in util/load.ts (`parseBlockFrontmatter` and the inline skill parser).
 */
function splitFrontmatter(
  content: string,
  isBlock: boolean,
): { body: string; frontmatter: string } | undefined {
  const delim = isBlock ? "+++" : "---";

  if (!content.startsWith(delim)) {
    return undefined;
  }

  const closingIdx = content.indexOf(delim, delim.length);
  if (closingIdx === -1) {
    return undefined;
  }

  let bodyStart = closingIdx + delim.length;
  if (content.startsWith("\r\n", bodyStart)) {
    bodyStart += 2;
  } else if (content.startsWith("\n", bodyStart)) {
    bodyStart += 1;
  }

  return {
    body: content.slice(bodyStart),
    frontmatter: content.slice(0, bodyStart),
  };
}

export {
  requiresFrontmatter,
  splitFrontmatter,
  validateFrontmatter,
  BlockFrontmatterSchema,
  SkillFrontmatterSchema,
};
