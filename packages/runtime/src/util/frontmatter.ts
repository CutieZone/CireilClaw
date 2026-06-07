/**
 * Utility for preserving frontmatter in block/skill files during write and str-replace operations.
 *
 * Block files use TOML frontmatter delimited by `+++...+++`.
 * Skill files use YAML frontmatter delimited by `---...---`.
 * In both cases the frontmatter is REQUIRED — the loading code throws if it's missing or malformed.
 */

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

export { requiresFrontmatter, splitFrontmatter };
