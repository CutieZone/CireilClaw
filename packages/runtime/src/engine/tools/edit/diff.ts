/**
 * Diff generation for the edit tool.
 *
 * Uses the `diff` library to produce both display-oriented diffs (with line
 * numbers) and standard unified patches.
 */

import { createTwoFilesPatch, diffLines, type Change } from "diff";

export interface DiffResult {
  /** Display-oriented diff string with line numbers. */
  diff: string;
  /** Standard unified patch. */
  patch: string;
  /** 1-indexed line number of the first change in the new file, if any. */
  firstChangedLine: number | undefined;
}

// ---------------------------------------------------------------------------
// Display diff
// ---------------------------------------------------------------------------

interface DiffLine {
  text: string;
  type: "added" | "removed" | "unchanged";
}

interface Hunk {
  lines: DiffLine[];
}

function emitLines(
  lines: DiffLine[],
  output: string[],
  lineNumWidth: number,
  baseLineNum: number,
): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const num = String(baseLineNum + i).padStart(lineNumWidth, " ");
    output.push(` ${num} ${line.text}`);
  }
}

function buildHunks(changes: Change[]): Hunk[] {
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;

  for (const change of changes) {
    const lines = change.value.split("\n");
    // diffLines includes trailing newline as empty string — remove it
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    const type: "added" | "removed" | "unchanged" = change.added
      ? "added"
      : change.removed
        ? "removed"
        : "unchanged";

    for (const line of lines) {
      if (line === undefined) continue;

      // Start a new hunk when the type changes
      if (currentHunk === null || currentHunk.lines[0]?.type !== type) {
        currentHunk = { lines: [] };
        hunks.push(currentHunk);
      }
      currentHunk.lines.push({ text: line, type });
    }
  }

  return hunks;
}

/**
 * Generate a display-oriented diff string with line numbers, matching the
 * format produced by most diff tools.
 */
export function generateDisplayDiff(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const changes = diffLines(oldContent, newContent);
  const hunks = buildHunks(changes);

  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  const output: string[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let hunkIdx = 0; hunkIdx < hunks.length; hunkIdx++) {
    const hunk = hunks[hunkIdx];
    if (hunk === undefined) continue;
    const type = hunk.lines[0]?.type;
    const nextHunk = hunks[hunkIdx + 1];

    if (type === "added" || type === "removed") {
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum;
      }

      for (const line of hunk.lines) {
        if (line.type === "added") {
          const num = String(newLineNum).padStart(lineNumWidth, " ");
          output.push(`+${num} ${line.text}`);
          newLineNum++;
        } else {
          const num = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(`-${num} ${line.text}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      // Unchanged context block
      const raw = hunk.lines;
      const nextIsChange = nextHunk !== undefined && nextHunk.lines[0]?.type !== "unchanged";
      const prevIsChange = lastWasChange;

      if (!prevIsChange && !nextIsChange) {
        // Isolated context — skip entirely
        oldLineNum += raw.length;
        newLineNum += raw.length;
        continue;
      }

      if (prevIsChange && nextIsChange) {
        // Between two changes: show up to contextLines on each side
        if (raw.length <= contextLines * 2) {
          emitLines(raw, output, lineNumWidth, oldLineNum);
          oldLineNum += raw.length;
          newLineNum += raw.length;
        } else {
          const leadingLines = raw.slice(0, contextLines);
          const trailingLines = raw.slice(raw.length - contextLines);
          const skippedLines = raw.length - leadingLines.length - trailingLines.length;

          emitLines(leadingLines, output, lineNumWidth, oldLineNum);
          oldLineNum += leadingLines.length;
          newLineNum += leadingLines.length;

          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;

          emitLines(trailingLines, output, lineNumWidth, oldLineNum);
          oldLineNum += trailingLines.length;
          newLineNum += trailingLines.length;
        }
      } else if (prevIsChange) {
        // After a change: show up to contextLines
        const shownLines = raw.slice(0, contextLines);
        const skippedLines = raw.length - shownLines.length;

        emitLines(shownLines, output, lineNumWidth, oldLineNum);
        oldLineNum += shownLines.length;
        newLineNum += shownLines.length;

        if (skippedLines > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
        }
      } else {
        // Before a change: show up to contextLines
        const skippedLines = Math.max(0, raw.length - contextLines);
        if (skippedLines > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
        }

        for (const line of raw.slice(skippedLines)) {
          const num = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(` ${num} ${line.text}`);
          oldLineNum++;
          newLineNum++;
        }
      }

      lastWasChange = false;
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}

// ---------------------------------------------------------------------------
// Unified patch
// ---------------------------------------------------------------------------

/**
 * Generate a standard unified diff patch using the `diff` library.
 */
export function generateUnifiedPatch(
  path: string,
  oldContent: string,
  newContent: string,
  contextLines = 4,
): string {
  const patchPath = path.replace(/^\//, "");
  const rawPatch = createTwoFilesPatch(
    `a/${patchPath}`,
    `b/${patchPath}`,
    oldContent,
    newContent,
    undefined,
    undefined,
    { context: contextLines },
  );

  // Strip the "Index: ..." header and separator that createTwoFilesPatch adds
  const lines = rawPatch.split("\n");
  while (
    lines.length > 0 &&
    (lines[0]?.startsWith("Index:") ||
      (lines[0]?.startsWith("=") && lines[0]?.endsWith("=")) ||
      lines[0] === "")
  ) {
    lines.shift();
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Combined
// ---------------------------------------------------------------------------

/**
 * Generate both display diff and unified patch in one pass.
 */
export function generateDiff(
  path: string,
  oldContent: string,
  newContent: string,
  contextLines = 4,
): DiffResult {
  const { diff, firstChangedLine } = generateDisplayDiff(oldContent, newContent, contextLines);
  const patch = generateUnifiedPatch(path, oldContent, newContent, contextLines);
  return { diff, patch, firstChangedLine };
}
