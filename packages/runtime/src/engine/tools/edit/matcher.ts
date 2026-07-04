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

interface FuzzyMatch {
  end: number;
  line: number;
  start: number;
}

interface NearObject {
  direction?: "before" | "after";
  endLine?: number;
  index?: number;
  line?: number;
  radius?: number;
  startLine?: number;
  symbol?: string;
}

type NearAnchor = string | NearObject | (string | NearObject)[];

interface EditOperation {
  oldText: string;
  newText: string;
  near?: NearAnchor;
  all?: boolean;
}

interface ResolvedEdit extends FuzzyMatch {
  newText: string;
  editIndex: number;
}

interface ApplyResult {
  baseContent: string;
  newContent: string;
  edits: ResolvedEdit[];
}

interface EditMetadata {
  editIndex: number;
  endLine: number;
  newLines: number;
  replacedLines: number;
  startLine: number;
}

interface ByteWindow {
  end: number;
  start: number;
}

interface AnchorResult {
  landmarkLine?: number;
  radius?: number;
  windows: ByteWindow[];
}

interface MatchError {
  context?: string;
  message: string;
}

const NEAR_WINDOW_LINES = 15;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeForMatch(str: string): string {
  return str
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      return trimmed.replaceAll(/\s+/gu, " ");
    })
    .join("\n");
}

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

function buildNormalized(content: string): { boundaries: number[]; norm: string } {
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

  return { boundaries, norm: normChars.join("") };
}

// ---------------------------------------------------------------------------
// Line helpers
// ---------------------------------------------------------------------------

function computeLineOffsets(content: string): number[] {
  const offsets: number[] = [0];
  for (let idx = 0; idx < content.length; idx++) {
    if (content[idx] === "\n") {
      offsets.push(idx + 1);
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

  return { end: endOffset, start: startOffset };
}

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

function fuzzyFindAll(content: string, needle: string): FuzzyMatch[] {
  const normNeedle = normalizeForMatch(needle);
  if (normNeedle.length === 0) {
    return [];
  }

  const { boundaries, norm } = buildNormalized(content);
  const lineOffsets = computeLineOffsets(content);
  const matches: FuzzyMatch[] = [];

  let idx = norm.indexOf(normNeedle);
  while (idx !== -1) {
    const start = boundaries[idx];
    const end = boundaries[idx + normNeedle.length];
    if (start !== undefined && end !== undefined) {
      matches.push({
        end,
        line: findLine(lineOffsets, start),
        start,
      });
    }
    idx = norm.indexOf(normNeedle, idx + 1);
  }

  return matches;
}

function findAllMatches(content: string, needle: string): FuzzyMatch[] {
  const exact: FuzzyMatch[] = [];
  let idx = content.indexOf(needle);
  const lineOffsets = computeLineOffsets(content);
  while (idx !== -1) {
    exact.push({
      end: idx + needle.length,
      line: findLine(lineOffsets, idx),
      start: idx,
    });
    idx = content.indexOf(needle, idx + 1);
  }
  if (exact.length > 0) {
    return exact;
  }
  return fuzzyFindAll(content, needle);
}

function deduplicateMatches(matches: FuzzyMatch[]): FuzzyMatch[] {
  const sorted = [...matches].toSorted(
    (left, right) => left.start - right.start || left.end - right.end,
  );
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

function formatMatchContext(match: FuzzyMatch, lineOffsets: number[], fileContent: string): string {
  const lines = fileContent.split("\n");
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

function matchesToString(matches: FuzzyMatch[], fileContent: string): string {
  const lineOffsets = computeLineOffsets(fileContent);
  return matches.map((match) => formatMatchContext(match, lineOffsets, fileContent)).join("\n\n");
}

// ---------------------------------------------------------------------------
// Near anchor resolution
// ---------------------------------------------------------------------------

function mergeWindows(windows: ByteWindow[]): ByteWindow[] {
  if (windows.length <= 1) {
    return windows;
  }
  const merged: ByteWindow[] = [];
  for (const win of windows.toSorted((left, right) => left.start - right.start)) {
    const last = merged.at(-1);
    if (last !== undefined && win.start <= last.end) {
      last.end = Math.max(last.end, win.end);
    } else {
      merged.push({ ...win });
    }
  }
  return merged;
}

function intersectWindows(initial: ByteWindow[], next: ByteWindow[]): ByteWindow[] {
  const result: ByteWindow[] = [];
  for (const iw of initial) {
    for (const nw of next) {
      const start = Math.max(iw.start, nw.start);
      const end = Math.min(iw.end, nw.end);
      if (start < end) {
        result.push({ end, start });
      }
    }
  }
  return mergeWindows(result);
}

function resolveLandmark(
  chosen: FuzzyMatch | undefined,
  direction: string | undefined,
  radius: number,
  lineOffsets: number[],
  contentLength: number,
  editIndex: number,
  symbol: string,
): AnchorResult | MatchError {
  if (chosen === undefined) {
    return {
      message: `Could not find symbol "${symbol}" for edits[${editIndex}].`,
    };
  }

  const landmarkLine = chosen.line;
  let startLine: number | undefined = undefined;
  let endLine: number | undefined = undefined;

  if (direction === "after") {
    startLine = landmarkLine + 1;
    endLine = landmarkLine + radius;
  } else if (direction === "before") {
    startLine = Math.max(1, landmarkLine - radius);
    endLine = landmarkLine - 1;
  } else {
    startLine = Math.max(1, landmarkLine - radius);
    endLine = landmarkLine + radius;
  }

  if (startLine > endLine) {
    const where = direction ?? "around";
    return {
      message:
        `"near" ${where} window for symbol "${symbol}" at line ${landmarkLine} ` +
        `is empty for edits[${editIndex}].`,
    };
  }

  return {
    landmarkLine,
    radius,
    windows: [lineRangeToOffsets(lineOffsets, startLine, endLine, contentLength)],
  };
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
        context: excerpt,
        message:
          `Could not find "near" anchor for edits[${editIndex}]. ` +
          `If "${anchor}" is a symbol name, use code_index_symbols to verify the exact name and file location before using it as an anchor.`,
      };
    }

    const windows: ByteWindow[] = nearMatches.map((match) => {
      const windowStartLine = Math.max(1, match.line - NEAR_WINDOW_LINES);
      const windowEndLine = Math.min(lineOffsets.length, match.line + NEAR_WINDOW_LINES);
      return lineRangeToOffsets(lineOffsets, windowStartLine, windowEndLine, contentLength);
    });

    return {
      landmarkLine: nearMatches[0]?.line,
      radius: NEAR_WINDOW_LINES,
      windows: mergeWindows(windows),
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

    if (obj.index !== undefined) {
      const adjustedIndex = Math.floor(obj.index) - 1;
      const chosenMatch = symbolMatches[adjustedIndex];
      if (chosenMatch === undefined) {
        return {
          message:
            `Symbol "${obj.symbol}" has ${symbolMatches.length} occurrence(s); ` +
            `requested index ${obj.index} is out of range for edits[${editIndex}].`,
        };
      }
      return resolveLandmark(
        chosenMatch,
        obj.direction,
        radius,
        lineOffsets,
        contentLength,
        editIndex,
        obj.symbol,
      );
    }

    if (obj.line !== undefined) {
      const candidates = symbolMatches
        // oxlint-disable-next-line typescript/no-non-null-assertion
        .map((match) => ({ dist: Math.abs(match.line - obj.line!), match }))
        .filter(({ dist }) => dist <= radius)
        .toSorted((left, right) => left.dist - right.dist);

      if (candidates.length === 0) {
        return {
          message:
            `Could not find symbol "${obj.symbol}" within ${radius} lines of line ${obj.line} ` +
            `for edits[${editIndex}].`,
        };
      }

      const first = candidates.at(0);
      const second = candidates.at(1);
      if (first === undefined) {
        return {
          message: `Could not find symbol "${obj.symbol}" for edits[${editIndex}].`,
        };
      }
      if (second !== undefined && first.dist === second.dist) {
        return {
          message:
            `Symbol "${obj.symbol}" near line ${obj.line} is ambiguous for edits[${editIndex}] ` +
            `(multiple occurrences at the same distance).`,
        };
      }

      return resolveLandmark(
        first.match,
        obj.direction,
        radius,
        lineOffsets,
        contentLength,
        editIndex,
        obj.symbol,
      );
    }

    if (symbolMatches.length > 1) {
      return {
        message:
          `Symbol "${obj.symbol}" is ambiguous (${symbolMatches.length} matches) for edits[${editIndex}]. ` +
          `Add line, index, or direction to disambiguate.`,
      };
    }

    return resolveLandmark(
      symbolMatches[0],
      obj.direction,
      radius,
      lineOffsets,
      contentLength,
      editIndex,
      obj.symbol,
    );
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
      return { windows: [{ end: contentLength, start: 0 }] };
    }

    let windows: ByteWindow[] = [{ end: contentLength, start: 0 }];

    for (let idx = 0; idx < anchor.length; idx++) {
      const item = anchor[idx];
      if (item === undefined) {
        continue;
      }
      const itemResult = resolveSingleAnchorWindows(
        content,
        item,
        lineOffsets,
        contentLength,
        editIndex,
      );
      if ("message" in itemResult) {
        return itemResult;
      }

      windows = intersectWindows(windows, itemResult.windows);
      if (windows.length === 0) {
        return {
          message: `"near" anchors for edits[${editIndex}] have no overlapping window after landmark ${idx + 1}.`,
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

function editHasAnchor(edit: EditOperation): boolean {
  if (edit.near === undefined) {
    return false;
  }
  if (typeof edit.near === "string") {
    return edit.near.length > 0;
  }
  if (Array.isArray(edit.near)) {
    return edit.near.length > 0;
  }
  return true;
}

function resolveEdit(
  content: string,
  edit: EditOperation,
  editIndex: number,
): ResolvedEdit[] | MatchError {
  const lineOffsets = computeLineOffsets(content);

  let searchWindows: ByteWindow[] | undefined = undefined;
  let anchorResult: AnchorResult | undefined = undefined;

  const nearAnchor = edit.near;
  if (nearAnchor !== undefined && editHasAnchor(edit)) {
    const resolved = resolveAnchorWindows(
      content,
      nearAnchor,
      lineOffsets,
      content.length,
      editIndex,
    );
    if ("message" in resolved) {
      return resolved;
    }
    anchorResult = resolved;
    searchWindows = resolved.windows;
  }

  if (searchWindows !== undefined) {
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
          end: win.start + windowMatch.end,
          line: findLine(lineOffsets, absStart),
          start: absStart,
        });
      }
    }

    if (windowedMatches.length === 0) {
      const [firstWin] = searchWindows;
      if (firstWin === undefined) {
        return {
          message: `Could not find edits[${editIndex}] in the file (empty search window).`,
        };
      }
      const winStartLine = findLine(lineOffsets, firstWin.start);
      const winEndLine = findLine(lineOffsets, Math.max(0, firstWin.end - 1));
      const excerpt = content
        .split("\n")
        .slice(winStartLine - 1, winEndLine)
        .join("\n");

      if (anchorResult?.landmarkLine !== undefined && anchorResult.radius !== undefined) {
        return {
          context: excerpt,
          message:
            `Found "near" for edits[${editIndex}] at line ${anchorResult.landmarkLine}, ` +
            `but "oldText" was not found within ${anchorResult.radius} lines of it.`,
        };
      }

      return {
        context: excerpt,
        message: `Found "near" anchor for edits[${editIndex}], but "oldText" was not found within the resulting window.`,
      };
    }

    const dedupedWindowed = deduplicateMatches(windowedMatches);
    if (edit.all !== true && dedupedWindowed.length > 1) {
      return {
        context: matchesToString(dedupedWindowed, content),
        message:
          `Found ${dedupedWindowed.length} matches for edits[${editIndex}]. ` +
          `Set "all: true" to replace all, add "near" to target a specific one, or make oldText more specific.`,
      };
    }
    return dedupedWindowed.map((match) => {
      const result: ResolvedEdit = {
        editIndex,
        end: match.end,
        line: match.line,
        newText: edit.newText,
        start: match.start,
      };
      return result;
    });
  }

  const allMatches = deduplicateMatches(findAllMatches(content, edit.oldText));

  if (allMatches.length === 0) {
    const excerpt = content.length > 500 ? `${content.slice(0, 500)}...` : content;
    return {
      context: excerpt,
      message: `Could not find edits[${editIndex}] in the file.`,
    };
  }

  if (edit.all !== true && allMatches.length > 1) {
    return {
      context: matchesToString(allMatches, content),
      message:
        `Found ${allMatches.length} matches for edits[${editIndex}]. ` +
        `Set "all: true" to replace all, add "near" to target a specific one, or make oldText more specific.`,
    };
  }

  return allMatches.map((match) => {
    const result: ResolvedEdit = {
      editIndex,
      end: match.end,
      line: match.line,
      newText: edit.newText,
      start: match.start,
    };
    return result;
  });
}

function applyEdits(
  content: string,
  edits: EditOperation[],
  path: string,
  frontmatterOffset?: number,
): ApplyResult {
  if (edits.length === 0) {
    throw new Error(`No edits provided for ${path}.`);
  }

  const resolvedPerEdit: ResolvedEdit[][] = [];
  for (let idx = 0; idx < edits.length; idx++) {
    const iterEdit = edits[idx];
    if (iterEdit === undefined) {
      continue;
    }
    if (iterEdit.oldText.trim().length === 0) {
      throw new Error(`edits[${idx}].oldText must not be empty or whitespace-only in ${path}.`);
    }

    if (iterEdit.oldText === iterEdit.newText) {
      continue;
    }

    const resolved = resolveEdit(content, iterEdit, idx);
    if ("message" in resolved) {
      const context = resolved.context === undefined ? "" : `\n\nContext:\n${resolved.context}`;
      throw new Error(resolved.message + context);
    }
    resolvedPerEdit.push(resolved);
  }

  const allResolved = resolvedPerEdit.flat();

  if (frontmatterOffset !== undefined) {
    for (const resolved of allResolved) {
      resolved.line += frontmatterOffset;
    }
  }

  const sorted = [...allResolved].toSorted((left, right) => left.start - right.start);
  for (let idx = 1; idx < sorted.length; idx++) {
    const prev = sorted[idx - 1];
    const curr = sorted[idx];
    if (prev !== undefined && curr !== undefined && prev.end > curr.start) {
      throw new Error(
        `edits[${prev.editIndex}] and edits[${curr.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  let newContent = content;
  for (let idx = sorted.length - 1; idx >= 0; idx--) {
    const edit = sorted[idx];
    if (edit === undefined) {
      continue;
    }
    newContent = newContent.slice(0, edit.start) + edit.newText + newContent.slice(edit.end);
  }

  if (newContent === content) {
    throw new Error(`No changes made to ${path}. The replacements produced identical content.`);
  }

  return { baseContent: content, edits: sorted, newContent };
}

function countLinesInSnippet(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

function getEditMetadata(baseContent: string, edits: ResolvedEdit[]): EditMetadata[] {
  const lineOffsets = computeLineOffsets(baseContent);
  let lineDelta = 0;
  const result: EditMetadata[] = [];

  for (const edit of edits) {
    const baseStartLine = findLine(lineOffsets, edit.start);
    const startLine = baseStartLine + lineDelta;
    const replacedLines = countLinesInSnippet(baseContent.slice(edit.start, edit.end));
    const newLines = countLinesInSnippet(edit.newText);
    const endLine = startLine + Math.max(0, newLines - 1);

    result.push({
      editIndex: edit.editIndex,
      endLine,
      newLines,
      replacedLines,
      startLine,
    });
    lineDelta += newLines - replacedLines;
  }

  return result;
}

export { applyEdits, getEditMetadata };
export type { ApplyResult, EditMetadata, EditOperation, NearAnchor, NearObject, ResolvedEdit };
