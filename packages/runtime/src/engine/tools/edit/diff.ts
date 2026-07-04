/**
 * Diff generation for the edit tool.
 *
 * Uses the `diff` library to produce both display-oriented diffs (with line
 * numbers) and standard unified patches.
 */

import { createTwoFilesPatch, diffLines } from "diff";
import type { Change } from "diff";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiffLine {
  text: string;
  type: "added" | "removed" | "unchanged";
}

interface Hunk {
  lines: DiffLine[];
}

interface DiffResult {
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

function emitLines(
  lines: DiffLine[],
  output: string[],
  lineNumWidth: number,
  baseLineNum: number,
): void {
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line === undefined) {
      continue;
    }
    const num = String(baseLineNum + idx).padStart(lineNumWidth, " ");
    output.push(` ${num} ${line.text}`);
  }
}

function buildHunks(changes: Change[]): Hunk[] {
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | undefined = undefined;

  for (const change of changes) {
    const rawLines = change.value.split("\n");
    if (rawLines.length > 0 && rawLines.at(-1) === "") {
      rawLines.pop();
    }

    let type: "added" | "removed" | "unchanged" = "unchanged";
    if (change.added) {
      type = "added";
    } else if (change.removed) {
      type = "removed";
    }

    for (const line of rawLines) {
      if (
        currentHunk === undefined ||
        currentHunk.lines.length === 0 ||
        currentHunk.lines[0]?.type !== type
      ) {
        currentHunk = { lines: [] };
        hunks.push(currentHunk);
      }
      currentHunk.lines.push({ text: line, type });
    }
  }

  return hunks;
}

function generateDisplayDiff(
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
  let firstChangedLine: number | undefined = undefined;

  for (let hunkIdx = 0; hunkIdx < hunks.length; hunkIdx++) {
    const hunk = hunks[hunkIdx];
    if (hunk === undefined) {
      continue;
    }
    const type = hunk.lines.at(0)?.type;
    const nextHunk = hunks[hunkIdx + 1];

    if (type === "added" || type === "removed") {
      firstChangedLine ??= newLineNum;

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
      const raw = hunk.lines;
      const nextIsChange = nextHunk !== undefined && nextHunk.lines.at(0)?.type !== "unchanged";
      const prevIsChange = lastWasChange;

      if (!prevIsChange && !nextIsChange) {
        oldLineNum += raw.length;
        newLineNum += raw.length;
        continue;
      }

      if (prevIsChange && nextIsChange) {
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

function generateUnifiedPatch(
  path: string,
  oldContent: string,
  newContent: string,
  contextLines = 4,
): string {
  const patchPath = path.replace(/^\//u, "");
  const rawPatch = createTwoFilesPatch(
    `a/${patchPath}`,
    `b/${patchPath}`,
    oldContent,
    newContent,
    undefined,
    undefined,
    { context: contextLines },
  );

  const lines = rawPatch.split("\n");
  while (lines.length > 0) {
    const [firstLine] = lines;
    if (firstLine === undefined) {
      break;
    }
    if (firstLine.startsWith("Index:") || firstLine === "") {
      lines.shift();
    } else if (firstLine.startsWith("=") && firstLine.endsWith("=")) {
      lines.shift();
    } else {
      break;
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Combined
// ---------------------------------------------------------------------------

function generateDiff(
  path: string,
  oldContent: string,
  newContent: string,
  contextLines = 4,
): DiffResult {
  const { diff, firstChangedLine } = generateDisplayDiff(oldContent, newContent, contextLines);
  const patch = generateUnifiedPatch(path, oldContent, newContent, contextLines);
  return { diff, firstChangedLine, patch };
}

export { generateDiff, generateDisplayDiff, generateUnifiedPatch };
export type { DiffResult };
