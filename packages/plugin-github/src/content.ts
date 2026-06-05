import type { ToolDef, ToolResult } from "@cireilclaw/sdk";
import { ToolError, vb } from "@cireilclaw/sdk";

import { gh, ghParse } from "./api.js";
import type { GHContent, GHSearchResult, GHCodeItem } from "./types.js";

// ── github-read-file ────────────────────────────────────────────────

const readFileSchema = vb.strictObject({
  owner: vb.pipe(vb.string(), vb.nonEmpty()),
  path: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("File path within the repo (e.g. src/index.ts)"),
  ),
  ref: vb.exactOptional(
    vb.pipe(vb.string(), vb.description("Branch, tag, or commit SHA (default: default branch)")),
  ),
  repo: vb.pipe(vb.string(), vb.nonEmpty()),
});

const MAX_RAW_FALLBACK_BYTES = 10 * 1024 * 1024;

const githubReadFile: ToolDef = {
  description: "Read a file's contents from a GitHub repository.",
  async execute(raw: unknown, ctx): Promise<ToolResult> {
    const { owner, repo, path, ref } = vb.parse(readFileSchema, raw);
    const params = ref === undefined ? "" : `?ref=${encodeURIComponent(ref)}`;
    const data = await ghParse<GHContent>(
      ctx,
      "GET",
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${params}`,
    );

    if (data.type !== "file") {
      throw new ToolError(
        `Path "${path}" is a ${data.type}, not a file. Use github-list-contents to list it.`,
      );
    }

    if (data.encoding !== "base64" || data.content === "") {
      if (data.size > MAX_RAW_FALLBACK_BYTES) {
        throw new ToolError(
          `File "${path}" is ${String(data.size)} bytes (max ${String(MAX_RAW_FALLBACK_BYTES)}). Use github-read-file with a ref or clone the repo locally.`,
        );
      }
      // Fall back to raw endpoint for non-base64 encodings
      const refQuery = ref === undefined ? "" : `?ref=${encodeURIComponent(ref)}`;
      const rawResponse = await gh(
        ctx,
        "GET",
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${refQuery}`,
        undefined,
        { Accept: "application/vnd.github.v3.raw" },
      );
      if (!rawResponse.ok) {
        throw new ToolError(
          `Failed to read file "${path}": encoding is "${data.encoding}" and raw fallback returned ${String(rawResponse.status)}.`,
        );
      }
      const rawContent = await rawResponse.text();
      return {
        content: rawContent,
        encoding: data.encoding,
        htmlUrl: data.html_url,
        name: data.name,
        path: data.path,
        sha: data.sha,
        size: data.size,
        success: true,
      };
    }

    const content = Buffer.from(data.content, "base64").toString("utf8");
    return {
      content,
      encoding: data.encoding,
      htmlUrl: data.html_url,
      name: data.name,
      path: data.path,
      sha: data.sha,
      size: data.size,
      success: true,
    };
  },
  name: "github-read-file",
  parameters: readFileSchema,
};

// ── github-list-contents ────────────────────────────────────────────

const listContentsSchema = vb.strictObject({
  owner: vb.pipe(vb.string(), vb.nonEmpty()),
  path: vb.exactOptional(
    vb.pipe(vb.string(), vb.description("Directory path (default: root)")),
    "",
  ),
  ref: vb.exactOptional(
    vb.pipe(vb.string(), vb.description("Branch, tag, or commit SHA (default: default branch)")),
  ),
  repo: vb.pipe(vb.string(), vb.nonEmpty()),
});

const githubListContents: ToolDef = {
  description: "List files and directories in a repository path.",
  async execute(raw: unknown, ctx): Promise<ToolResult> {
    const { owner, repo, path, ref } = vb.parse(listContentsSchema, raw);
    const encPath = path === "" ? "" : `/${encodeURIComponent(path)}`;
    const params = ref === undefined ? "" : `?ref=${encodeURIComponent(ref)}`;
    const data = await ghParse<GHContent | GHContent[]>(
      ctx,
      "GET",
      `/repos/${owner}/${repo}/contents${encPath}${params}`,
    );

    const items = (Array.isArray(data) ? data : [data]).map((item) => ({
      htmlUrl: item.html_url,
      name: item.name,
      path: item.path,
      size: item.size,
      type: item.type,
    }));

    return { items, success: true };
  },
  name: "github-list-contents",
  parameters: listContentsSchema,
};

// ── github-search-code ──────────────────────────────────────────────

const searchCodeSchema = vb.strictObject({
  limit: vb.exactOptional(
    vb.pipe(
      vb.number(),
      vb.integer(),
      vb.minValue(1),
      vb.maxValue(30),
      vb.description("Max results (default 5)"),
    ),
    5,
  ),
  query: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("Search query (supports GitHub qualifiers like repo:, language:, path:)"),
  ),
});

const githubSearchCode: ToolDef = {
  description: "Search code across GitHub repositories.",
  async execute(raw: unknown, ctx): Promise<ToolResult> {
    const { limit, query } = vb.parse(searchCodeSchema, raw);
    const params = new URLSearchParams();
    params.set("per_page", String(limit));
    params.set("q", query);
    const result = await ghParse<GHSearchResult<GHCodeItem>>(
      ctx,
      "GET",
      `/search/code?${String(params)}`,
    );
    const results = result.items.map((item) => ({
      htmlUrl: item.html_url,
      name: item.name,
      path: item.path,
      repo: item.repository?.full_name ?? undefined,
    }));
    return { results, success: true, totalCount: result.total_count };
  },
  name: "github-search-code",
  parameters: searchCodeSchema,
};

export const contentTools: Record<string, ToolDef> = {
  "github-list-contents": githubListContents,
  "github-read-file": githubReadFile,
  "github-search-code": githubSearchCode,
};
