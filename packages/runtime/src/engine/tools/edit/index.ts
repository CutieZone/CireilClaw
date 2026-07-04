import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import * as vb from "valibot";

import { ToolError } from "#engine/errors.js";
import type { ToolContext, ToolDef } from "#engine/tools/tool-def.js";
import { requiresFrontmatter, splitFrontmatter, validateFrontmatter } from "#util/frontmatter.js";

import { generateDiff } from "./diff.js";
import { applyEdits, getEditMetadata, type EditOperation } from "./matcher.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const NearObjectSchema = vb.strictObject({
  symbol: vb.exactOptional(
    vb.pipe(
      vb.string(),
      vb.description(
        "Symbol/landmark text to find. Fuzzy-matched like oldText. Use with line, index, direction, or radius to disambiguate.",
      ),
    ),
  ),
  line: vb.exactOptional(
    vb.pipe(
      vb.number(),
      vb.description(
        "Expected 1-indexed line of the symbol. The nearest occurrence within radius lines is used.",
      ),
    ),
  ),
  startLine: vb.exactOptional(
    vb.pipe(
      vb.number(),
      vb.description("Start of an explicit 1-indexed line-range window. Use with endLine."),
    ),
  ),
  endLine: vb.exactOptional(
    vb.pipe(
      vb.number(),
      vb.description("End of an explicit 1-indexed line-range window. Use with startLine."),
    ),
  ),
  index: vb.exactOptional(
    vb.pipe(
      vb.number(),
      vb.description("1-indexed occurrence of the symbol to target (e.g. 2 for the second match)."),
    ),
  ),
  direction: vb.exactOptional(
    vb.pipe(
      vb.union([vb.literal("before"), vb.literal("after")]),
      vb.description(
        "Search only before or after the matched landmark. Default searches around the landmark.",
      ),
    ),
  ),
  radius: vb.exactOptional(
    vb.pipe(
      vb.number(),
      vb.description("Number of lines around the landmark to search. Default: 15."),
    ),
  ),
});

const NearAnchorSchema = vb.union([
  vb.string(),
  NearObjectSchema,
  vb.array(vb.union([vb.string(), NearObjectSchema])),
]);

const SingleEditSchema = vb.strictObject({
  oldText: vb.pipe(
    vb.string(),
    vb.description(
      "Text to find. Fuzzy whitespace matching is used by default: differences in indentation, trailing spaces, tabs vs spaces, and intra-line spacing are forgiven. Newlines still matter as logical line separators. Standard JSON escape sequences are supported: \\n for newlines, \\t for tabs, \\\\ for a literal backslash, etc.",
    ),
  ),
  newText: vb.pipe(
    vb.string(),
    vb.description(
      "Replacement text. Pass an empty string to delete oldText. Standard JSON escape sequences are supported: \\n for newlines, \\t for tabs, \\\\ for a literal backslash, etc.",
    ),
  ),
  near: vb.exactOptional(NearAnchorSchema),
  all: vb.exactOptional(
    vb.pipe(vb.boolean(), vb.description("Replace all occurrences of oldText. Default: false.")),
  ),
});

const EditSchema = vb.strictObject({
  path: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("Sandbox path of the file to edit (e.g. /workspace/main.ts)."),
  ),
  dryRun: vb.exactOptional(
    vb.pipe(
      vb.boolean(),
      vb.description(
        "If true, compute the diff/patch and metadata without writing to disk. Useful for previewing changes.",
      ),
    ),
  ),
  apply: vb.exactOptional(
    vb.pipe(
      vb.string(),
      vb.description(
        "Apply a previously computed dry-run by its applyId. The file must not have changed since the dry-run. When set, 'edits' must not be provided.",
      ),
    ),
  ),
  edits: vb.exactOptional(
    vb.pipe(
      vb.array(SingleEditSchema),
      vb.description(
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not emit overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead. Required unless 'apply' is used.",
      ),
    ),
  ),
});

// ---------------------------------------------------------------------------
// Legacy compatibility
// ---------------------------------------------------------------------------

/**
 * Convert legacy single-edit parameters (old_text/new_text) to the new
 * edits[] format, preserving backward compatibility.
 */
function prepareArguments(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }

  const args = input as Record<string, unknown>;

  // apply mode: no legacy conversion needed
  if (args["apply"] !== undefined) {
    return input;
  }

  // If edits[] is already provided (even if alongside legacy params), use as-is
  if (Array.isArray(args["edits"]) && (args["edits"] as unknown[]).length > 0) {
    return input;
  }

  // Check for legacy old_text/new_text (snake_case)
  const oldText = args["old_text"];
  const newText = args["new_text"];

  if (typeof oldText === "string" && typeof newText === "string") {
    const legacyEdit: Record<string, unknown> = {
      oldText,
      newText,
    };

    // Carry over optional legacy params
    const argsNear = args["near"];
    const argsAll = args["all"];
    if (argsNear !== undefined) legacyEdit["near"] = argsNear;
    if (argsAll !== undefined) legacyEdit["all"] = argsAll;

    const { old_text: _o, new_text: _n, near: _near, all: _all, ...rest } = args;
    return {
      ...rest,
      edits: [legacyEdit],
    };
  }

  return input;
}

// ---------------------------------------------------------------------------
// Dry-run cache
// ---------------------------------------------------------------------------

interface DryRunCacheEntry {
  absolutePath: string;
  baseContentHash: string;
  baseContent: string;
  newContent: string;
  path: string;
  edits: {
    editIndex: number;
    startLine: number;
    endLine: number;
    replacedLines: number;
    newLines: number;
  }[];
  diff: string;
  patch: string;
  firstChangedLine: number | undefined;
  createdAt: number;
}

const dryRunCache = new Map<string, DryRunCacheEntry>();
const MAX_DRY_RUN_CACHE_SIZE = 100;

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function pruneDryRunCache(): void {
  if (dryRunCache.size <= MAX_DRY_RUN_CACHE_SIZE) return;
  const entries = [...dryRunCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  const overflow = entries.slice(0, entries.length - MAX_DRY_RUN_CACHE_SIZE);
  for (const [key] of overflow) {
    dryRunCache.delete(key);
  }
}

function storeDryRun(
  applyId: string,
  absolutePath: string,
  baseContent: string,
  newContent: string,
  path: string,
  edits: {
    editIndex: number;
    startLine: number;
    endLine: number;
    replacedLines: number;
    newLines: number;
  }[],
  diff: string,
  patch: string,
  firstChangedLine: number | undefined,
): void {
  dryRunCache.set(applyId, {
    absolutePath,
    baseContentHash: hashContent(baseContent),
    baseContent,
    newContent,
    path,
    edits,
    diff,
    patch,
    firstChangedLine,
    createdAt: Date.now(),
  });
  pruneDryRunCache();
}

async function applyDryRun(
  applyId: string,
  realPath: string,
  dataPath: string,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const entry = dryRunCache.get(applyId);
  if (entry === undefined) {
    throw new ToolError(`No dry-run found for applyId: ${applyId}. Run a dry-run first.`);
  }

  if (entry.absolutePath !== realPath) {
    throw new ToolError(
      `apply path mismatch: dry-run was for ${entry.path}, but apply targets a different path.`,
    );
  }

  const currentContent = await readFile(realPath, "utf8");
  const normalizedContent = currentContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (hashContent(normalizedContent) !== entry.baseContentHash) {
    throw new ToolError(
      "File content has changed since the dry-run. Run a new dry-run and apply with the updated applyId.",
    );
  }

  await writeFile(realPath, entry.newContent, "utf8");
  ctx.session.activeFileSections.delete(dataPath);

  return {
    content: entry.newContent,
    detail: `Successfully applied dry-run ${applyId}: replaced ${entry.edits.length} block(s) in ${entry.path}.`,
    diff: entry.diff,
    patch: entry.patch,
    firstChangedLine: entry.firstChangedLine,
    edits: entry.edits,
    success: true,
  };
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

// oxlint-disable-next-line sort-keys
export const edit: ToolDef = {
  name: "edit",
  parameters: EditSchema,
  description:
    "Performs string replacements in an existing file with fuzzy whitespace matching.\n\n" +
    "Whitespace in `oldText` and `near` is matched fuzzily: differences in " +
    "indentation, trailing spaces, tabs vs spaces, or intra-line spacing are " +
    "forgiven. Newlines still matter as logical line separators.\n\n" +
    "For files under /blocks/ and /skills/, search happens within the body only " +
    "— the required frontmatter is transparently preserved and never matched or modified.\n\n" +
    "Parameters:\n" +
    "- `edits` (required, unless using `apply`): array of { oldText, newText, near?, all? }\n" +
    "- `path` (required): sandbox path of the file to edit.\n" +
    "- `dryRun` (optional): preview changes without writing. Returns applyId for later use.\n" +
    "- `apply` (optional): apply a previous dry-run by its applyId.\n\n" +
    "When changing multiple separate locations, use multiple entries in `edits[]` " +
    "instead of separate tool calls. Each edit is matched against the original file, " +
    "not incrementally.\n\n" +
    "Tips:\n" +
    "- Use `read` first to see current file contents.\n" +
    "- Prefer short `oldText` with `near` for disambiguation over copying " +
    "large blocks of exact whitespace.\n" +
    "- If `oldText` appears multiple times, either set `all: true` or add " +
    "`near` to target a specific one.\n" +
    "- Use structured `near` objects (symbol + line, startLine/endLine, index) " +
    "with code_index_symbols for precise targeting.\n" +
    "- Use `dryRun: true` to preview a diff before it is written to disk.\n\n" +
    "When NOT to use:\n" +
    "- Creating new files or rewriting an entire file — use `write` instead.\n" +
    "- The file doesn't exist yet — use `write` instead.\n\n" +
    "Note that paths used here *must* be absolute.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(EditSchema, prepareArguments(input));
    const realPath = await ctx.paths.resolve(data.path);

    await ctx.paths.checkConditionalAccess(data.path);
    await ctx.paths.checkWriteAccess(data.path);

    // Handle apply mode
    if (data.apply !== undefined) {
      return applyDryRun(data.apply, realPath, data.path, ctx);
    }

    if (!data.edits || data.edits.length === 0) {
      throw new ToolError(
        "No edits provided.",
        "Provide at least one edit in the `edits` array, or use `apply` to apply a previous dry-run.",
      );
    }

    if (!existsSync(realPath)) {
      throw new ToolError(
        `File at ${data.path} does not exist.`,
        "Did you mean to use the 'write' tool?",
      );
    }

    const fileContent = await readFile(realPath, "utf8");

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

    // Apply edits using the matcher
    let result;
    try {
      result = applyEdits(
        searchContent,
        data.edits as EditOperation[],
        data.path,
        frontmatterLineCount,
      );
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError((error as Error).message);
    }

    // Validate preserved frontmatter before writing — catches pre-existing
    // corruption so the agent gets immediate feedback instead of a load failure later.
    if (frontmatter !== undefined) {
      try {
        validateFrontmatter(frontmatter, data.path.startsWith("/blocks/"));
      } catch (error) {
        throw new ToolError((error as Error).message);
      }
    }

    const newContent =
      frontmatter === undefined ? result.newContent : frontmatter + result.newContent;

    // Generate diff
    const diffResult = generateDiff(data.path, result.baseContent, result.newContent);

    // Build edit metadata
    const editMetadata = getEditMetadata(result.baseContent, result.edits);

    if (data.dryRun) {
      // Store dry-run for later application
      const applyId = randomUUID();
      storeDryRun(
        applyId,
        realPath,
        result.baseContent,
        newContent,
        data.path,
        editMetadata,
        diffResult.diff,
        diffResult.patch,
        diffResult.firstChangedLine,
      );

      return {
        applyId,
        detail: `Dry-run: would replace ${result.edits.length} block(s) in ${data.path}. Apply with applyId: ${applyId}`,
        diff: diffResult.diff,
        patch: diffResult.patch,
        firstChangedLine: diffResult.firstChangedLine,
        edits: editMetadata,
        success: true,
      };
    }

    await writeFile(realPath, newContent, "utf8");
    ctx.session.activeFileSections.delete(data.path);

    return {
      detail: `Successfully replaced ${result.edits.length} block(s) in ${data.path}.`,
      diff: diffResult.diff,
      patch: diffResult.patch,
      firstChangedLine: diffResult.firstChangedLine,
      edits: editMetadata,
      success: true,
    };
  },
};
