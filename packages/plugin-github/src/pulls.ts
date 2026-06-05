import type { ToolDef, ToolResult } from "@cireilclaw/sdk";
import { vb } from "@cireilclaw/sdk";

import { ghPaginate, ghParse } from "./api.js";
import type { GHPullRequest, GHPrFile } from "./types.js";

// ── github-read-pr ──────────────────────────────────────────────────

const readPrSchema = vb.strictObject({
  number: vb.pipe(vb.number(), vb.integer(), vb.minValue(1), vb.description("PR number")),
  owner: vb.pipe(vb.string(), vb.nonEmpty()),
  repo: vb.pipe(vb.string(), vb.nonEmpty()),
});

const githubReadPr: ToolDef = {
  description: "Get detailed information about a specific pull request.",
  async execute(raw: unknown, ctx): Promise<ToolResult> {
    const { owner, repo, number } = vb.parse(readPrSchema, raw);
    const pr = await ghParse<GHPullRequest>(
      ctx,
      "GET",
      `/repos/${owner}/${repo}/pulls/${String(number)}`,
    );
    return {
      additions: pr.additions,
      base: pr.base.ref,
      body: pr.body,
      changedFiles: pr.changed_files,
      closedAt: pr.closed_at,
      comments: pr.comments,
      commits: pr.commits,
      createdAt: pr.created_at,
      deletions: pr.deletions,
      draft: pr.draft,
      head: pr.head.ref,
      headRepo: pr.head.repo?.full_name ?? undefined,
      htmlUrl: pr.html_url,
      mergeable: pr.mergeable,
      merged: pr.merged,
      mergedAt: pr.merged_at,
      number: pr.number,
      state: pr.state,
      success: true,
      title: pr.title,
      url: pr.html_url,
      user: pr.user?.login ?? undefined,
    };
  },
  name: "github-read-pr",
  parameters: readPrSchema,
};

// ── github-list-prs ─────────────────────────────────────────────────

const listPrsSchema = vb.strictObject({
  base: vb.exactOptional(vb.pipe(vb.string(), vb.description("Filter by base branch name"))),
  direction: vb.exactOptional(
    vb.pipe(
      vb.picklist(["asc", "desc"] as const),
      vb.description("Sort direction (default: desc)"),
    ),
    "desc",
  ),
  head: vb.exactOptional(vb.pipe(vb.string(), vb.description("Filter by head branch name"))),
  owner: vb.pipe(vb.string(), vb.nonEmpty()),
  perPage: vb.exactOptional(
    vb.pipe(
      vb.number(),
      vb.integer(),
      vb.minValue(1),
      vb.maxValue(100),
      vb.description("Results per page (max 100)"),
    ),
    20,
  ),
  repo: vb.pipe(vb.string(), vb.nonEmpty()),
  sort: vb.exactOptional(
    vb.pipe(
      vb.picklist(["created", "updated", "popularity", "long-running"] as const),
      vb.description("Sort field (default: created)"),
    ),
    "created",
  ),
  state: vb.exactOptional(
    vb.pipe(
      vb.picklist(["open", "closed", "all"] as const),
      vb.description("Filter by state (default: open)"),
    ),
    "open",
  ),
});

const githubListPrs: ToolDef = {
  description: "List pull requests in a repository with optional filters.",
  async execute(raw: unknown, ctx): Promise<ToolResult> {
    const { owner, repo, state, head, base, sort, direction, perPage } = vb.parse(
      listPrsSchema,
      raw,
    );
    const params = new URLSearchParams({ direction, per_page: String(perPage), sort, state });
    if (head !== undefined) {
      params.set("head", head);
    }
    if (base !== undefined) {
      params.set("base", base);
    }

    const items = await ghParse<GHPullRequest[]>(
      ctx,
      "GET",
      `/repos/${owner}/${repo}/pulls?${params.toString()}`,
    );
    const prs = items.map((pr) => ({
      createdAt: pr.created_at,
      draft: pr.draft,
      head: pr.head.ref,
      htmlUrl: pr.html_url,
      number: pr.number,
      state: pr.state,
      title: pr.title,
      updatedAt: pr.updated_at,
      user: pr.user?.login ?? undefined,
    }));
    return { prs, success: true };
  },
  name: "github-list-prs",
  parameters: listPrsSchema,
};

// ── github-list-pr-files ────────────────────────────────────────────

const listPrFilesSchema = vb.strictObject({
  number: vb.pipe(vb.number(), vb.integer(), vb.minValue(1)),
  owner: vb.pipe(vb.string(), vb.nonEmpty()),
  repo: vb.pipe(vb.string(), vb.nonEmpty()),
});

const githubListPrFiles: ToolDef = {
  description: "List files changed in a pull request.",
  async execute(raw: unknown, ctx): Promise<ToolResult> {
    const { owner, repo, number } = vb.parse(listPrFilesSchema, raw);
    const items = await ghPaginate<GHPrFile>(
      ctx,
      `/repos/${owner}/${repo}/pulls/${String(number)}/files?per_page=100`,
    );
    const files = items.map((file) => ({
      additions: file.additions,
      blobUrl: file.blob_url,
      changes: file.changes,
      contentsUrl: file.contents_url,
      deletions: file.deletions,
      filename: file.filename,
      patch: file.patch,
      rawUrl: file.raw_url,
      status: file.status,
    }));
    return { files, success: true };
  },
  name: "github-list-pr-files",
  parameters: listPrFilesSchema,
};

export const prTools: Record<string, ToolDef> = {
  "github-list-pr-files": githubListPrFiles,
  "github-list-prs": githubListPrs,
  "github-read-pr": githubReadPr,
};
