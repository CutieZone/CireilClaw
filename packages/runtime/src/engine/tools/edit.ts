import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import * as vb from "valibot";

import { ToolError } from "#engine/errors.js";
import type { ToolContext, ToolDef } from "#engine/tools/tool-def.js";
import { requiresFrontmatter, splitFrontmatter, validateFrontmatter } from "#util/frontmatter.js";

const Schema = vb.strictObject({
  all: vb.exactOptional(
    vb.pipe(vb.boolean(), vb.description("Replace all occurrences of old_text. Default: false.")),
  ),
  near: vb.exactOptional(
    vb.pipe(
      vb.string(),
      vb.description(
        "Anchor text that scopes the search to within 15 lines of each match. " +
          "Use a function name, variable declaration, or distinctive comment " +
          "to quickly narrow the search. Fuzzy-matched (whitespace differences forgiven).",
      ),
    ),
  ),
  new_text: vb.pipe(
    vb.string(),
    vb.description("Replacement text. Pass an empty string to delete old_text."),
  ),
  old_text: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description(
      "Text to find. Whitespace is matched fuzzily — differences in indentation, " +
        "trailing spaces, tabs vs spaces, and intra-line spacing are forgiven. " +
        "Newlines still matter as logical line separators.",
    ),
  ),
  path: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("Sandbox path of the file to edit (e.g. /workspace/main.ts)."),
  ),
});

// ---------------------------------------------------------------------------
// Normalization & Fuzzy Matching
// ---------------------------------------------------------------------------

/**
 * Normalize a string for fuzzy comparison: trim per-line, collapse internal
 * whitespace runs to a single space. Blank lines are preserved structurally.
 */
function normalize(str: string): string {
  return str
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      return trimmed.replaceAll(/\s+/gu, " ");
    })
    .join("\n");
}

/**
 * Returns the next normalized character at `pos` in `content` along with the
 * number of original bytes consumed.
 *
 * Rules (in order):
 *  1. `\n` → emit `\n`, consume 1
 *  2. Leading whitespace (between line-start and first non-ws) → skip entirely
 *  3. Trailing whitespace (between last non-ws and newline/EOF) → skip entirely
 *  4. Content whitespace (mid-line ws runs) → emit `' '`, consume entire run
 *  5. Non-whitespace → emit the char, consume 1
 */
function nextNormChar(content: string, pos: number): [string | undefined, number] {
  if (pos >= content.length) {
    return [undefined, 0];
  }

  const ch = content[pos];

  // Rule 1: Newline
  if (ch === "\n") {
    return ["\n", 1];
  }

  const atLineStart = pos === 0 || content[pos - 1] === "\n";

  // Rule 2: Leading whitespace — skip entirely, recurse to first content byte
  if (atLineStart && (ch === " " || ch === "\t" || ch === "\r")) {
    const regexResult = /^[ \t\r]+/u.exec(content.slice(pos));
    const wsLen = regexResult?.[0]?.length ?? 0;
    if (wsLen > 0) {
      const [normChar, inner] = nextNormChar(content, pos + wsLen);
      return [normChar, wsLen + inner];
    }
  }

  // Rule 3 & 4: Whitespace within a line
  if (ch === " " || ch === "\t") {
    const regexResult = /^[ \t\r]+/u.exec(content.slice(pos));
    const wsLen = regexResult?.[0]?.length ?? 1;

    // Trailing whitespace: runs to newline or EOF
    if (pos + wsLen >= content.length || content[pos + wsLen] === "\n") {
      const [normChar, inner] = nextNormChar(content, pos + wsLen);
      return [normChar, wsLen + inner];
    }

    // Content whitespace — emit single space
    return [" ", wsLen];
  }

  // Rule 5: Non-whitespace
  return [ch, 1];
}

/**
 * Precompute byte offset of the start of each line (0-indexed).
 */
function computeLineOffsets(content: string): number[] {
  const offsets: number[] = [0];
  for (let offsetIdx = 0; offsetIdx < content.length; offsetIdx++) {
    if (content[offsetIdx] === "\n") {
      offsets.push(offsetIdx + 1);
    }
  }
  return offsets;
}

/**
 * Find the 1-indexed line number for a given byte offset.
 */
function findLine(lineOffsets: number[], byteOffset: number): number {
  let low = 0;
  let high = lineOffsets.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    const offset = lineOffsets[mid];
    if (offset !== undefined && offset <= byteOffset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low + 1;
}

/**
 * Convert a 1-indexed line range to byte offsets. `endLine` is inclusive.
 */
function lineRangeToOffsets(
  lineOffsets: number[],
  startLine: number,
  endLine: number,
  contentLength: number,
): { end: number; start: number } {
  const clampedStart = Math.max(0, startLine - 1);
  const clampedEnd = Math.min(lineOffsets.length - 1, endLine - 1);
  const startOffset = lineOffsets[clampedStart];
  const endOffset =
    clampedEnd < lineOffsets.length - 1 ? lineOffsets[clampedEnd + 1] : contentLength;

  if (endOffset === undefined || startOffset === undefined) {
    throw new Error("Invalid line range: start or end line is out of bounds");
  }

  return { end: endOffset, start: startOffset };
}

interface FuzzyMatch {
  end: number;
  line: number;
  start: number;
}

/**
 * Find all fuzzy matches of `needle` in `content`.
 *
 * Both `needle` and `content` are compared via their normalized forms, with
 * position information mapped back to original byte offsets.
 */
function fuzzyFindAll(content: string, needle: string): FuzzyMatch[] {
  const normNeedle = normalize(needle);
  if (normNeedle.length === 0) {
    return [];
  }

  const lineOffsets = computeLineOffsets(content);
  const matches: FuzzyMatch[] = [];

  for (let startPos = 0; startPos < content.length; startPos++) {
    let normIdx = 0;
    let origPos = startPos;
    let matched = true;

    while (normIdx < normNeedle.length && origPos < content.length) {
      const [normChar, consumed] = nextNormChar(content, origPos);
      const needleChar = normNeedle[normIdx];
      if (normChar === undefined || normChar !== needleChar) {
        matched = false;
        break;
      }
      origPos += consumed;
      normIdx++;
    }

    if (matched && normIdx === normNeedle.length) {
      const line = findLine(lineOffsets, startPos);
      matches.push({ end: origPos, line, start: startPos });
    }
  }

  return matches;
}

/**
 * Format a match with surrounding context for error messages.
 * Shows 2 lines before and after, with the matched line highlighted
 * via `>>>...<<<` markers. If the match spans multiple lines, each
 * affected line is annotated.
 */
function formatMatchContext(match: FuzzyMatch, lineOffsets: number[], fileContent: string): string {
  const lines = fileContent.split("\n");
  const ctxBefore = Math.max(0, match.line - 3);
  const ctxAfter = Math.min(lines.length, match.line + 2);
  const result: string[] = [];

  for (let lineIdx = ctxBefore; lineIdx < ctxAfter; lineIdx++) {
    const lineNum = lineIdx + 1;
    const line = lines[lineIdx] ?? "";
    const lineStart = lineOffsets[lineIdx];

    if (lineStart === undefined) {
      throw new Error(`Line offset not found for line ${lineNum}`);
    }

    const lineEnd = lineStart + line.length;

    if (lineNum === match.line) {
      if (match.start >= lineStart && match.end <= lineEnd) {
        // Match entirely within this line
        const before = line.slice(0, match.start - lineStart);
        const matched = line.slice(match.start - lineStart, match.end - lineStart);
        result.push(`  line ${lineNum}: ${before}>>>${matched}<<<`);
      } else if (match.start >= lineStart && match.start < lineEnd) {
        // Match starts on this line
        const before = line.slice(0, match.start - lineStart);
        const matchedPart = line.slice(match.start - lineStart);
        result.push(`  line ${lineNum}: ${before}>>>${matchedPart}`);
      } else if (match.end > lineStart && match.end <= lineEnd) {
        // Match ends on this line
        const matchedPart = line.slice(0, match.end - lineStart);
        result.push(`  line ${lineNum}: ${matchedPart}<<<`);
      } else if (match.start < lineStart && match.end > lineEnd) {
        // Match spans across this line
        result.push(`  line ${lineNum}: ${line}`);
      }
    } else {
      result.push(`  line ${lineNum}: ${line}`);
    }
  }

  return result.join("\n");
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

// oxlint-disable-next-line sort-keys
export const edit: ToolDef = {
  name: "edit",
  parameters: Schema,
  description:
    "Performs string replacements in an existing file with fuzzy whitespace matching.\n\n" +
    "Whitespace in `old_text` and `near` is matched fuzzily: differences in " +
    "indentation, trailing spaces, tabs vs spaces, or intra-line spacing are " +
    "forgiven. Newlines still matter as logical line separators.\n\n" +
    "For files under /blocks/ and /skills/, search happens within the body only " +
    "— the required frontmatter is transparently preserved and never matched or modified.\n\n" +
    "Parameters:\n" +
    "- `old_text` (required): non-empty text to find. Fuzzy-matched.\n" +
    "- `new_text` (required): replacement text. Empty to delete.\n" +
    "- `near` (optional): anchor text that scopes the search to within 15 lines " +
    "of each match. Use a function name, variable declaration, or distinctive " +
    "comment to quickly narrow the search. Fuzzy-matched.\n" +
    "- `all` (optional, default false): replace all occurrences.\n\n" +
    "Tips:\n" +
    "- Use `read` first to see current file contents.\n" +
    "- Prefer short `old_text` with `near` for disambiguation over copying " +
    "large blocks of exact whitespace.\n" +
    "- If `old_text` appears multiple times, either set `all: true` or add " +
    "`near` to target a specific one.\n\n" +
    "When NOT to use:\n" +
    "- Creating new files or rewriting an entire file — use `write` instead.\n" +
    "- The file doesn't exist yet — use `write` instead.\n\n" +
    "Note that paths used here *must* be absolute.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(Schema, input);

    const path = await ctx.paths.resolve(data.path);

    await ctx.paths.checkConditionalAccess(data.path);
    await ctx.paths.checkWriteAccess(data.path);

    if (!existsSync(path)) {
      throw new ToolError(
        `File at ${data.path} does not exist.`,
        "Did you mean to use the 'write' tool?",
      );
    }

    const fileContent = await readFile(path, "utf8");

    // For files with required frontmatter (blocks, skills), extract the
    // frontmatter and search/replace within the body only. The frontmatter
    // is transparently preserved so the agent never accidentally corrupts it.
    let searchContent = fileContent;
    let frontmatter: string | undefined = undefined;
    let frontmatterLineCount = 0;

    if (requiresFrontmatter(data.path)) {
      const split = splitFrontmatter(fileContent, data.path.startsWith("/blocks/"));
      if (split !== undefined) {
        ({ frontmatter, body: searchContent } = split);
        frontmatterLineCount = frontmatter.split("\n").length - 1;
      }
    }

    // Find fuzzy matches of old_text in the search content
    let matches: FuzzyMatch[] = [];

    if (data.near === undefined) {
      // Full-file search
      matches = fuzzyFindAll(searchContent, data.old_text);
    } else {
      // Near-anchored search: find near matches, window around them,
      // then search for old_text within each window
      const nearMatches = fuzzyFindAll(searchContent, data.near);
      if (nearMatches.length === 0) {
        const excerpt =
          searchContent.length > 500 ? `${searchContent.slice(0, 500)}...` : searchContent;
        throw new ToolError(
          `Could not find "near" in the file, even with fuzzy matching.\n\n` +
            `File content (first 500 chars):\n${excerpt}\n\n` +
            `Try a different anchor (function name, variable, comment) or omit "near" ` +
            `to search the entire file.`,
        );
      }

      const lineOffsets = computeLineOffsets(searchContent);
      const windows: { end: number; start: number }[] = [];
      for (const nearMatch of nearMatches) {
        const lineIdx = nearMatch.line - 1;
        const windowStartLine = Math.max(0, lineIdx - 15);
        const windowEndLine = Math.min(lineOffsets.length - 1, lineIdx + 15);
        const win = lineRangeToOffsets(
          lineOffsets,
          windowStartLine + 1,
          windowEndLine + 1,
          searchContent.length,
        );
        windows.push(win);
      }

      // Merge overlapping windows
      windows.sort((left, right) => left.start - right.start);
      const merged: { end: number; start: number }[] = [];
      for (const win of windows) {
        const last = merged.at(-1);
        if (last !== undefined && win.start <= last.end) {
          last.end = Math.max(last.end, win.end);
        } else {
          merged.push({ end: win.end, start: win.start });
        }
      }

      // Find old_text matches within each window
      const seenStarts = new Set<number>();
      const windowedMatches: FuzzyMatch[] = [];
      for (const win of merged) {
        const windowContent = searchContent.slice(win.start, win.end);
        const windowMatches = fuzzyFindAll(windowContent, data.old_text);
        for (const windowMatch of windowMatches) {
          const absStart = win.start + windowMatch.start;
          if (seenStarts.has(absStart)) {
            continue;
          }
          seenStarts.add(absStart);
          windowedMatches.push({
            end: win.start + windowMatch.end,
            line: windowMatch.line,
            start: absStart,
          });
        }
      }

      if (windowedMatches.length === 0) {
        const [nearFirst] = nearMatches;

        if (nearFirst === undefined) {
          throw new ToolError(`No near matches found for "${data.near}"`);
        }

        const windowStart = Math.max(0, nearFirst.line - 16);
        const windowEnd = Math.min(lineOffsets.length, nearFirst.line + 15);
        const excerpt = searchContent.split("\n").slice(windowStart, windowEnd).join("\n");
        throw new ToolError(
          `Found "near" at line ${nearFirst.line}, but "old_text" was not found within 15 lines of it.\n\n` +
            `Window around line ${nearFirst.line} (lines ${windowStart + 1}-${windowEnd}):\n` +
            `${excerpt.length > 500 ? `${excerpt.slice(0, 500)}...` : excerpt}\n\n` +
            `Try: expanding "old_text", using a different "near", or omitting "near" ` +
            `to search the entire file.`,
        );
      }

      matches = windowedMatches;
    }

    // Handle match counts
    if (matches.length === 0) {
      const excerpt =
        searchContent.length > 500 ? `${searchContent.slice(0, 500)}...` : searchContent;
      throw new ToolError(
        `Could not find "old_text" in the file, even with fuzzy whitespace matching.\n\n` +
          `File content (first 500 chars):\n${excerpt}\n\n` +
          `Try using "read" to see the current file contents, then re-craft "old_text".`,
      );
    }

    // Deduplicate overlapping matches: when two matches overlap, keep the one
    // with the smaller start (broader span). This prevents double-replacement
    // when "foo" matches both "  foo" (starting at whitespace) and "foo"
    // (starting at text) within the same span.
    const deduped: FuzzyMatch[] = [];
    for (const dedupMatch of matches) {
      const overlapping = deduped.findIndex(
        (existing) => existing.start <= dedupMatch.start && existing.end >= dedupMatch.end,
      );
      if (overlapping !== -1) {
        continue;
      }
      for (let dupIdx = deduped.length - 1; dupIdx >= 0; dupIdx--) {
        const existing = deduped[dupIdx];
        if (
          existing !== undefined &&
          dedupMatch.start <= existing.start &&
          dedupMatch.end >= existing.end
        ) {
          deduped.splice(dupIdx, 1);
        }
      }
      deduped.push(dedupMatch);
    }

    const replaceAll = data.all === true;

    if (replaceAll || deduped.length <= 1) {
      // Single match or all: true — proceed to replacement
    } else {
      const lineOffsets = computeLineOffsets(searchContent);
      const matchDetails = deduped
        .map((mappedMatch) => formatMatchContext(mappedMatch, lineOffsets, searchContent))
        .join("\n\n");

      const nearHint =
        data.near === undefined
          ? `To target one: either add "near" to scope the search, or add more ` +
            `surrounding context to "old_text" to make it unique.`
          : `To target one: use a more specific "near" anchor or add more ` +
            `context to "old_text".`;

      throw new ToolError(
        `Found ${deduped.length} matches for "old_text".\n` +
          `To replace all: set "all: true"\n${nearHint}\n\n` +
          `Matches:\n${matchDetails}`,
      );
    }

    // Apply replacements in ascending order (lowest start first) and adjust
    // both start and end by the cumulative length shift from prior replacements.
    const sorted = deduped.toSorted((left, right) => left.start - right.start);

    let newBody = searchContent;
    let totalShift = 0;
    for (const rm of sorted) {
      const adjStart = rm.start + totalShift;
      const adjEnd = rm.end + totalShift;
      newBody = newBody.slice(0, adjStart) + data.new_text + newBody.slice(adjEnd);
      totalShift += data.new_text.length - (rm.end - rm.start);
    }

    const newContent = frontmatter === undefined ? newBody : frontmatter + newBody;

    // Validate preserved frontmatter before writing — catches pre-existing
    // corruption so the agent gets immediate feedback instead of a load failure later.
    if (frontmatter !== undefined) {
      validateFrontmatter(frontmatter, data.path.startsWith("/blocks/"));
    }

    await writeFile(path, newContent, "utf8");

    // Invalidate section cache — file content changed
    ctx.session.activeFileSections.delete(data.path);

    // Return context info about the first replacement
    const firstMatch = sorted.at(-1) ?? deduped[0];

    if (firstMatch === undefined) {
      throw new Error(`No matches found for "${data.old_text}"`);
    }

    // Offset line index by frontmatter line count for the full-file context
    const lineIndex = firstMatch.line - 1 + frontmatterLineCount;
    const newLines = newContent.split("\n");
    const contextLines = 2;
    const contextStart = Math.max(0, lineIndex - contextLines);
    const contextEnd = Math.min(newLines.length, lineIndex + contextLines + 1);

    return {
      context: newLines.slice(contextStart, contextEnd).join("\n"),
      replaced: deduped.length,
      success: true,
    };
  },
};
