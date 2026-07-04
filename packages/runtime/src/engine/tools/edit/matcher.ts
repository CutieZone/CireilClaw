/**
 * Offset-preserving fuzzy matching for the edit tool.
 *
 * Design:
 * - Build a normalized view of the content once, then use native `indexOf`
 *   for matching. Map match positions back to original byte offsets via a
 *   boundary array. Never normalizes content outside the matched region.
 * - Forgiving: leading/trailing whitespace, tabs-vs-spaces, indentation depth.
 * - Supports rich `near` anchors (strings, structured objects, arrays).
 * - Supports batch edits with overlap detection.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FuzzyMatch {
  /** Byte offset in the original (LF-normalized) content where the match starts. */
  start: number;
  /** Byte offset in the original (LF-normalized) content where the match ends. */
  end: number;
  /** 1-indexed line number where the match starts. */
  line: number;
}

export interface NearObject {
  /** Symbol/landmark text to find. Fuzzy-matched like oldText. */
  symbol?: string;
  /** Expected 1-indexed line of the symbol. Filters matches to within radius. */
  line?: number;
  /** Explicit 1-indexed start line of a window. Use with endLine. */
  startLine?: number;
  /** Explicit 1-indexed end line of a window. Use with startLine. */
  endLine?: number;
  /** 1-indexed occurrence of the symbol to target (e.g. 2 for the second match). */
  index?: number;
  /** Search only before or after the matched landmark. */
  direction?: "before" | "after";
  /** Lines around the landmark to search. Default: 15. */
  radius?: number;
}

export type NearAnchor = string | NearObject | (string | NearObject)[];

export interface EditOperation {
  oldText: string;
  newText: string;
  near?: NearAnchor;
  all?: boolean;
}

export interface ResolvedEdit extends FuzzyMatch {
  newText: string;
  editIndex: number;
}

export interface ApplyResult {
  /** The original LF-normalized content. */
  baseContent: string;
  /** The content after all edits are applied. */
  newContent: string;
  /** The resolved edits, sorted by start position ascending. */
  edits: ResolvedEdit[];
}

export interface EditMetadata {
  /** Index into the original edits[] array. */
  editIndex: number;
  /** 1-indexed start line in the new file. */
  startLine: number;
  /** 1-indexed end line in the new file. */
  endLine: number;
  /** Number of original lines replaced. */
  replacedLines: number;
  /** Number of new lines inserted. */
  newLines: number;
}

interface ByteWindow {
  start: number;
  end: number;
}

interface AnchorResult {
  windows: ByteWindow[];
  landmarkLine?: number;
  radius?: number;
}

interface MatchError {
  message: string;
  context?: string;
}

const NEAR_WINDOW_LINES = 15;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize text for fuzzy comparison: trim each line and collapse internal
 * whitespace runs to a single space. Blank lines are preserved structurally.
 */
function normalizeForMatch(str: string): string {
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

  if (ch === "\n") {
    return ["\n", 1];
  }

  const atLineStart = pos === 0 || content[pos - 1] === "\n";

  if (atLineStart && (ch === " " || ch === "\t")) {
    const wsMatch = /^[ \t]+/u.exec(content.slice(pos));
    const wsLen = wsMatch?.[0]?.length ?? 0;
    if (wsLen > 0) {
      const [normChar, inner] = nextNormChar(content, pos + wsLen);
      return [normChar, wsLen + inner];
    }
  }

  if (ch === " " || ch === "\t") {
    const wsMatch = /^[ \t]+/u.exec(content.slice(pos));
    const wsLen = wsMatch?.[0]?.length ?? 1;

    if (pos + wsLen >= content.length || content[pos + wsLen] === "\n") {
      const [normChar, inner] = nextNormChar(content, pos + wsLen);
      return [normChar, wsLen + inner];
    }

    return [" ", wsLen];
  }

  return [ch, 1];
}

/**
 * Build a normalized view of the content plus a map from each normalized
 * position (before char i) to the original byte offset of that boundary.
 */
function buildNormalized(content: string): { norm: string; boundaries: number[] } {
  const normChars: string[] = [];
  const boundaries: number[] = [0];
  let pos = 0;

  while (pos < content.length) {
    const [ch, consumed] = nextNormChar(content, pos);
    if (ch === undefined) {
      break;
    }
    normChars.push(ch);
    boundaries.push(pos + consumed);
    pos += consumed;
  }

  return { norm: normChars.join(""), boundaries };
}

// ---------------------------------------------------------------------------
// Line helpers
// ---------------------------------------------------------------------------

function computeLineOffsets(content: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

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

function lineRangeToOffsets(
  lineOffsets: number[],
  startLine: number,
  endLine: number,
  contentLength: number,
): ByteWindow {
  const clampedStart = Math.max(0, startLine - 1);
  const clampedEnd = Math.min(lineOffsets.length - 1, endLine - 1);
  const startOffset = lineOffsets[clampedStart];
  const endOffset =
    clampedEnd < lineOffsets.length - 1 ? lineOffsets[clampedEnd + 1] : contentLength;

  if (startOffset === undefined || endOffset === undefined) {
    throw new Error(`Invalid line range: ${startLine}-${endLine}`);
  }

  return { start: startOffset, end: endOffset };
}

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

/**
 * Find all fuzzy matches of `needle` in `content`. Both are compared via their
 * normalized forms, with byte offsets mapped back to the original content.
 */
function fuzzyFindAll(content: string, needle: string): FuzzyMatch[] {
  const normNeedle = normalizeForMatch(needle);
  if (normNeedle.length === 0) {
    return [];
  }

  const { norm, boundaries } = buildNormalized(content);
  const lineOffsets = computeLineOffsets(content);
  const matches: FuzzyMatch[] = [];

  let idx = norm.indexOf(normNeedle);
  while (idx !== -1) {
    const start = boundaries[idx];
    const end = boundaries[idx + normNeedle.length];
    if (start !== undefined && end !== undefined) {
      matches.push({
        start,
        end,
        line: findLine(lineOffsets, start),
      });
    }
    idx = norm.indexOf(normNeedle, idx + 1);
  }

  return matches;
}

/**
 * Find exact matches first; fall back to fuzzy whitespace matching.
 * Returns all matches with original byte offsets.
 */
function findAllMatches(content: string, needle: string): FuzzyMatch[] {
  const exact: FuzzyMatch[] = [];
  let idx = content.indexOf(needle);
  const lineOffsets = computeLineOffsets(content);
  while (idx !== -1) {
    exact.push({ start: idx, end: idx + needle.length, line: findLine(lineOffsets, idx) });
    idx = content.indexOf(needle, idx + 1);
  }
  if (exact.length > 0) {
    return exact;
  }
  return fuzzyFindAll(content, needle);
}

/**
 * Deduplicate overlapping matches, keeping the broader span when one match
 * fully contains another.
 */
function deduplicateMatches(matches: FuzzyMatch[]): FuzzyMatch[] {
  const sorted = [...matches].sort((a, b) => a.start - b.start || a.end - b.end);
  const deduped: FuzzyMatch[] = [];

  for (const match of sorted) {
    const last = deduped.at(-1);
    if (last === undefined) {
      deduped.push(match);
      continue;
    }

    if (last.start <= match.start && last.end >= match.end) {
      continue;
    }

    if (match.start <= last.start && match.end >= last.end) {
      deduped[deduped.length - 1] = match;
      continue;
    }

    deduped.push(match);
  }

  return deduped;
}

function formatMatchContext(match: FuzzyMatch, lineOffsets: number[], content: string): string {
  const lines = content.split("\n");
  const ctxStart = Math.max(0, match.line - 3);
  const ctxEnd = Math.min(lines.length, match.line + 2);
  const result: string[] = [];

  for (let lineIdx = ctxStart; lineIdx < ctxEnd; lineIdx++) {
    const lineNum = lineIdx + 1;
    const line = lines[lineIdx] ?? "";
    const lineStart = lineOffsets[lineIdx];

    if (lineStart === undefined) {
      throw new Error(`Line offset not found for line ${lineNum}`);
    }

    const lineEnd = lineStart + line.length;

    if (lineNum === match.line) {
      if (match.start >= lineStart && match.end <= lineEnd) {
        const before = line.slice(0, match.start - lineStart);
        const matched = line.slice(match.start - lineStart, match.end - lineStart);
        result.push(`  line ${lineNum}: ${before}>>>${matched}<<<`);
      } else if (match.start >= lineStart && match.start < lineEnd) {
        const before = line.slice(0, match.start - lineStart);
        const matchedPart = line.slice(match.start - lineStart);
        result.push(`  line ${lineNum}: ${before}>>>${matchedPart}`);
      } else if (match.end > lineStart && match.end <= lineEnd) {
        const matchedPart = line.slice(0, match.end - lineStart);
        result.push(`  line ${lineNum}: ${matchedPart}<<<`);
      } else if (match.start < lineStart && match.end > lineEnd) {
        result.push(`  line ${lineNum}: ${line}`);
      }
    } else {
      result.push(`  line ${lineNum}: ${line}`);
    }
  }

  return result.join("\n");
}

function matchesToString(matches: FuzzyMatch[], content: string): string {
  const lineOffsets = computeLineOffsets(content);
  return matches.map((m) => formatMatchContext(m, lineOffsets, content)).join("\n\n");
}

// ---------------------------------------------------------------------------
// Near anchor resolution
// ---------------------------------------------------------------------------

function mergeWindows(windows: ByteWindow[]): ByteWindow[] {
  if (windows.length <= 1) return windows;
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const merged: ByteWindow[] = [];
  for (const win of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && win.start <= last.end) {
      last.end = Math.max(last.end, win.end);
    } else {
      merged.push({ ...win });
    }
  }
  return merged;
}

function intersectWindows(a: ByteWindow[], b: ByteWindow[]): ByteWindow[] {
  const result: ByteWindow[] = [];
  for (const aw of a) {
    for (const bw of b) {
      const start = Math.max(aw.start, bw.start);
      const end = Math.min(aw.end, bw.end);
      if (start < end) {
        result.push({ start, end });
      }
    }
  }
  return mergeWindows(result);
}

function resolveSingleAnchorWindows(
  content: string,
  anchor: string | NearObject,
  lineOffsets: number[],
  contentLength: number,
  editIndex: number,
): AnchorResult | MatchError {
  if (typeof anchor === "string") {
    const nearMatches = deduplicateMatches(findAllMatches(content, anchor));
    if (nearMatches.length === 0) {
      const excerpt = content.length > 500 ? `${content.slice(0, 500)}...` : content;
      return {
        message:
          `Could not find "near" anchor for edits[${editIndex}]. ` +
          `If "${anchor}" is a symbol name, use code_index_symbols to verify the exact name and file location before using it as an anchor.`,
        context: excerpt,
      };
    }

    const windows: ByteWindow[] = nearMatches.map((m) => {
      const startLine = Math.max(1, m.line - NEAR_WINDOW_LINES);
      const endLine = Math.min(lineOffsets.length, m.line + NEAR_WINDOW_LINES);
      return lineRangeToOffsets(lineOffsets, startLine, endLine, contentLength);
    });

    return {
      windows: mergeWindows(windows),
      landmarkLine: nearMatches[0]?.line,
      radius: NEAR_WINDOW_LINES,
    };
  }

  const obj = anchor;

  if (obj.startLine !== undefined || obj.endLine !== undefined) {
    if (obj.startLine === undefined || obj.endLine === undefined) {
      return {
        message: `Invalid "near" anchor for edits[${editIndex}]: startLine and endLine must both be specified.`,
      };
    }
    if (
      obj.startLine < 1 ||
      obj.endLine < 1 ||
      obj.startLine > lineOffsets.length ||
      obj.endLine > lineOffsets.length
    ) {
      return {
        message: `Invalid "near" line range for edits[${editIndex}]: lines ${obj.startLine}-${obj.endLine} are outside the file (${lineOffsets.length} lines).`,
      };
    }
    return {
      windows: [lineRangeToOffsets(lineOffsets, obj.startLine, obj.endLine, contentLength)],
    };
  }

  if (obj.symbol !== undefined) {
    const symbolMatches = deduplicateMatches(findAllMatches(content, obj.symbol));
    if (symbolMatches.length === 0) {
      return {
        message: `Could not find symbol "${obj.symbol}" for edits[${editIndex}].`,
      };
    }

    const radius = obj.radius ?? NEAR_WINDOW_LINES;
    let chosen: FuzzyMatch;

    if (obj.index !== undefined) {
      const idx = Math.floor(obj.index) - 1;
      if (idx < 0 || idx >= symbolMatches.length) {
        return {
          message:
            `Symbol "${obj.symbol}" has ${symbolMatches.length} occurrence(s); ` +
            `requested index ${obj.index} is out of range for edits[${editIndex}].`,
        };
      }
      chosen = symbolMatches[idx]!;
    } else if (obj.line !== undefined) {
      const candidates = symbolMatches
        .map((m) => ({ m, dist: Math.abs(m.line - obj.line!) }))
        .filter(({ dist }) => dist <= radius)
        .sort((a, b) => a.dist - b.dist);

      if (candidates.length === 0) {
        return {
          message:
            `Could not find symbol "${obj.symbol}" within ${radius} lines of line ${obj.line} ` +
            `for edits[${editIndex}].`,
        };
      }

      if (candidates.length > 1 && candidates[0]?.dist === candidates[1]?.dist) {
        return {
          message:
            `Symbol "${obj.symbol}" near line ${obj.line} is ambiguous for edits[${editIndex}] ` +
            `(multiple occurrences at the same distance).`,
        };
      }

      chosen = candidates[0]!.m;
    } else {
      if (symbolMatches.length > 1) {
        return {
          message:
            `Symbol "${obj.symbol}" is ambiguous (${symbolMatches.length} matches) for edits[${editIndex}]. ` +
            `Add line, index, or direction to disambiguate.`,
        };
      }
      chosen = symbolMatches[0]!;
    }

    const landmarkLine = chosen.line;
    let startLine: number;
    let endLine: number;

    if (obj.direction === "after") {
      startLine = landmarkLine + 1;
      endLine = landmarkLine + radius;
    } else if (obj.direction === "before") {
      startLine = Math.max(1, landmarkLine - radius);
      endLine = landmarkLine - 1;
    } else {
      startLine = Math.max(1, landmarkLine - radius);
      endLine = landmarkLine + radius;
    }

    if (startLine > endLine) {
      const where = obj.direction ?? "around";
      return {
        message:
          `"near" ${where} window for symbol "${obj.symbol}" at line ${landmarkLine} ` +
          `is empty for edits[${editIndex}].`,
      };
    }

    return {
      windows: [lineRangeToOffsets(lineOffsets, startLine, endLine, contentLength)],
      landmarkLine,
      radius,
    };
  }

  return {
    message: `Invalid "near" anchor for edits[${editIndex}]: expected a string, object with symbol/startLine/endLine, or array.`,
  };
}

function resolveAnchorWindows(
  content: string,
  anchor: NearAnchor,
  lineOffsets: number[],
  contentLength: number,
  editIndex: number,
): AnchorResult | MatchError {
  if (Array.isArray(anchor)) {
    if (anchor.length === 0) {
      return { windows: [{ start: 0, end: contentLength }] };
    }

    let windows: ByteWindow[] = [{ start: 0, end: contentLength }];

    for (let i = 0; i < anchor.length; i++) {
      const item = anchor[i];
      if (item === undefined) continue;
      const itemResult = resolveSingleAnchorWindows(
        content,
        item,
        lineOffsets,
        contentLength,
        editIndex,
      );
      if ("message" in itemResult) return itemResult;

      windows = intersectWindows(windows, itemResult.windows);
      if (windows.length === 0) {
        return {
          message: `"near" anchors for edits[${editIndex}] have no overlapping window after landmark ${i + 1}.`,
        };
      }
    }

    return { windows };
  }

  return resolveSingleAnchorWindows(content, anchor, lineOffsets, contentLength, editIndex);
}

// ---------------------------------------------------------------------------
// Edit resolution & application
// ---------------------------------------------------------------------------

/**
 * Resolve a single edit operation into one or more matches, respecting `near`
 * and `all`. Returns a MatchError if the edit cannot be applied unambiguously.
 */
function resolveEdit(
  content: string,
  edit: EditOperation,
  editIndex: number,
): ResolvedEdit[] | MatchError {
  const lineOffsets = computeLineOffsets(content);

  const hasAnchor =
    edit.near !== undefined &&
    (typeof edit.near === "string"
      ? edit.near.length > 0
      : Array.isArray(edit.near)
        ? edit.near.length > 0
        : true);

  let searchWindows: ByteWindow[] | undefined;
  let anchorResult: AnchorResult | undefined;

  if (hasAnchor) {
    const result = resolveAnchorWindows(
      content,
      edit.near!,
      lineOffsets,
      content.length,
      editIndex,
    );
    if ("message" in result) return result;
    anchorResult = result;
    searchWindows = result.windows;
  }

  let matches: FuzzyMatch[];

  if (searchWindows) {
    const seenStarts = new Set<number>();
    const windowedMatches: FuzzyMatch[] = [];

    for (const win of searchWindows) {
      const windowContent = content.slice(win.start, win.end);
      const windowMatches = findAllMatches(windowContent, edit.oldText);
      for (const windowMatch of windowMatches) {
        const absStart = win.start + windowMatch.start;
        if (seenStarts.has(absStart)) {
          continue;
        }
        seenStarts.add(absStart);
        windowedMatches.push({
          start: absStart,
          end: win.start + windowMatch.end,
          line: findLine(lineOffsets, absStart),
        });
      }
    }

    if (windowedMatches.length === 0) {
      const firstWin = searchWindows[0]!;
      const winStartLine = findLine(lineOffsets, firstWin.start);
      const winEndLine = findLine(lineOffsets, Math.max(0, firstWin.end - 1));
      const excerpt = content
        .split("\n")
        .slice(winStartLine - 1, winEndLine)
        .join("\n");

      if (anchorResult?.landmarkLine !== undefined && anchorResult.radius !== undefined) {
        return {
          message:
            `Found "near" for edits[${editIndex}] at line ${anchorResult.landmarkLine}, ` +
            `but "oldText" was not found within ${anchorResult.radius} lines of it.`,
          context: excerpt,
        };
      }

      return {
        message: `Found "near" anchor for edits[${editIndex}], but "oldText" was not found within the resulting window.`,
        context: excerpt,
      };
    }

    matches = deduplicateMatches(windowedMatches);
  } else {
    matches = deduplicateMatches(findAllMatches(content, edit.oldText));
  }

  if (matches.length === 0) {
    const excerpt = content.length > 500 ? `${content.slice(0, 500)}...` : content;
    return {
      message: `Could not find edits[${editIndex}] in the file.`,
      context: excerpt,
    };
  }

  if (!edit.all && matches.length > 1) {
    return {
      message:
        `Found ${matches.length} matches for edits[${editIndex}]. ` +
        `Set "all: true" to replace all, add "near" to target a specific one, or make oldText more specific.`,
      context: matchesToString(matches, content),
    };
  }

  return matches.map((m) => ({ ...m, newText: edit.newText, editIndex }));
}

/**
 * Apply a batch of edits to content. Edits are matched against the original
 * content, not incrementally. Throws on any failure.
 */
export function applyEdits(
  content: string,
  edits: EditOperation[],
  path: string,
  frontmatterOffset?: number,
): ApplyResult {
  if (edits.length === 0) {
    throw new Error(`No edits provided for ${path}.`);
  }

  const resolvedPerEdit: ResolvedEdit[][] = [];
  for (let i = 0; i < edits.length; i++) {
    const iterEdit = edits[i];
    if (iterEdit === undefined) {
      continue;
    }
    if (iterEdit.oldText.trim().length === 0) {
      throw new Error(`edits[${i}].oldText must not be empty or whitespace-only in ${path}.`);
    }

    if (iterEdit.oldText === iterEdit.newText) {
      continue;
    }

    const resolved = resolveEdit(content, iterEdit, i);
    if ("message" in resolved) {
      const err = new Error(
        resolved.message + (resolved.context ? `\n\nContext:\n${resolved.context}` : ""),
      );
      (err as Error & { isMatchError?: boolean }).isMatchError = true;
      throw err;
    }
    resolvedPerEdit.push(resolved);
  }

  const allResolved = resolvedPerEdit.flat();

  // Adjust match line numbers for frontmatter offset if present
  if (frontmatterOffset !== undefined) {
    for (const r of allResolved) {
      r.line += frontmatterOffset;
    }
  }

  // Check for overlaps across edits.
  const sorted = [...allResolved].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev !== undefined && curr !== undefined && prev.end > curr.start) {
      throw new Error(
        `edits[${prev.editIndex}] and edits[${curr.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  // Apply in reverse order so earlier offsets remain stable.
  let newContent = content;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const edit = sorted[i];
    if (edit === undefined) continue;
    newContent = newContent.slice(0, edit.start) + edit.newText + newContent.slice(edit.end);
  }

  if (newContent === content) {
    throw new Error(`No changes made to ${path}. The replacements produced identical content.`);
  }

  return { baseContent: content, newContent, edits: sorted };
}

function countLinesInSnippet(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

/**
 * Build per-edit metadata (start/end lines and line counts) for the new file.
 */
export function getEditMetadata(baseContent: string, edits: ResolvedEdit[]): EditMetadata[] {
  const lineOffsets = computeLineOffsets(baseContent);
  let lineDelta = 0;
  const result: EditMetadata[] = [];

  for (const edit of edits) {
    const baseStartLine = findLine(lineOffsets, edit.start);
    const startLine = baseStartLine + lineDelta;
    const replacedLines = countLinesInSnippet(baseContent.slice(edit.start, edit.end));
    const newLines = countLinesInSnippet(edit.newText);
    const endLine = startLine + Math.max(0, newLines - 1);

    result.push({ editIndex: edit.editIndex, startLine, endLine, replacedLines, newLines });
    lineDelta += newLines - replacedLines;
  }

  return result;
}
