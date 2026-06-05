import type { ToolDef, ToolResult } from "@cireilclaw/sdk";
import { vb } from "@cireilclaw/sdk";

import { ghParse } from "./api.js";
import type { GHIssue, GHSearchResult } from "./types.js";

// ── github-create-issue ─────────────────────────────────────────────

const createIssueSchema = vb.strictObject({
  assignees: vb.exactOptional(
    vb.pipe(vb.array(vb.string()), vb.description("Usernames to assign")),
  ),
  body: vb.exactOptional(vb.pipe(vb.string(), vb.description("Issue body (Markdown)"))),
  labels: vb.exactOptional(vb.pipe(vb.array(vb.string()), vb.description("Labels to apply"))),
  owner: vb.pipe(vb.string(), vb.nonEmpty(), vb.description("Repository owner (user or org)")),
  repo: vb.pipe(vb.string(), vb.nonEmpty(), vb.description("Repository name")),
  title: vb.pipe(vb.string(), vb.nonEmpty(), vb.description("Issue title")),
});

const githubCreateIssue: ToolDef = {
  description: "Create a new issue in a GitHub repository.",
  async execute(raw: unknown, ctx): Promise<ToolResult> {
    const { owner, repo, title, body, labels, assignees } = vb.parse(createIssueSchema, raw);
    const issue = await ghParse<GHIssue>(ctx, "POST", `/repos/${owner}/${repo}/issues`, {
      title,
      ...(body !== undefined && { body }),
      ...(labels !== undefined && { labels }),
      ...(assignees !== undefined && { assignees }),
    });
    return {
      number: issue.number,
      state: issue.state,
      success: true,
      title: issue.title,
      url: issue.html_url,
    };
  },
  name: "github-create-issue",
  parameters: createIssueSchema,
};

// ── github-read-issue ───────────────────────────────────────────────

const readIssueSchema = vb.strictObject({
  number: vb.pipe(vb.number(), vb.integer(), vb.minValue(1), vb.description("Issue number")),
  owner: vb.pipe(vb.string(), vb.nonEmpty()),
  repo: vb.pipe(vb.string(), vb.nonEmpty()),
});

const githubReadIssue: ToolDef = {
  description: "Get detailed information about a specific issue.",
  async execute(raw: unknown, ctx): Promise<ToolResult> {
    const { owner, repo, number } = vb.parse(readIssueSchema, raw);
    const issue = await ghParse<GHIssue>(ctx, "GET", `/repos/${owner}/${repo}/issues/${String(number)}`);
    return {
      assignees: issue.assignees.map((user) => user.login),
      body: issue.body,
      comments: issue.comments,
      createdAt: issue.created_at,
      htmlUrl: issue.html_url,
      labels: issue.labels.map((label) => (typeof label === "string" ? label : label.name)),
      number: issue.number,
      state: issue.state,
      success: true,
      title: issue.title,
      updatedAt: issue.updated_at,
      user: issue.user?.login ?? undefined,
    };
  },
  name: "github-read-issue",
  parameters: readIssueSchema,
};

// ── github-list-issues ──────────────────────────────────────────────

const listIssuesSchema = vb.strictObject({
  assignee: vb.exactOptional(vb.pipe(vb.string(), vb.description("Filter by assignee username"))),
  direction: vb.exactOptional(
    vb.pipe(
      vb.picklist(["asc", "desc"] as const),
      vb.description("Sort direction (default: desc)"),
    ),
    "desc",
  ),
  labels: vb.exactOptional(
    vb.pipe(vb.string(), vb.description("Comma-separated list of label names to filter by")),
  ),
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
      vb.picklist(["created", "updated", "comments"] as const),
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

const githubListIssues: ToolDef = {
  description: "List issues in a repository with optional filters.",
  async execute(raw: unknown, ctx): Promise<ToolResult> {
    const { owner, repo, state, labels, assignee, sort, direction, perPage } = vb.parse(
      listIssuesSchema,
      raw,
    );
    const params = new URLSearchParams({ direction, per_page: String(perPage), sort, state });
    if (labels !== undefined) {
      params.set("labels", labels);
    }
    if (assignee !== undefined) {
      params.set("assignee", assignee);
    }

    const items = await ghParse<GHIssue[]>(ctx, "GET", `/repos/${owner}/${repo}/issues?${String(params)}`);
    const issues = items
      .filter((item) => item.pull_request === undefined)
      .map((item) => ({
        assignees: item.assignees.map((user) => user.login),
        comments: item.comments,
        createdAt: item.created_at,
        htmlUrl: item.html_url,
        labels: item.labels.map((label) => (typeof label === "string" ? label : label.name)),
        number: item.number,
        state: item.state,
        title: item.title,
        updatedAt: item.updated_at,
        user: item.user?.login ?? undefined,
      }));
    return { issues, success: true };
  },
  name: "github-list-issues",
  parameters: listIssuesSchema,
};

// ── github-update-issue ─────────────────────────────────────────────

const updateIssueSchema = vb.strictObject({
  body: vb.exactOptional(vb.pipe(vb.string(), vb.description("New body (Markdown)"))),
  labels: vb.exactOptional(vb.pipe(vb.array(vb.string()), vb.description("Replacement labels"))),
  number: vb.pipe(vb.number(), vb.integer(), vb.minValue(1)),
  owner: vb.pipe(vb.string(), vb.nonEmpty()),
  repo: vb.pipe(vb.string(), vb.nonEmpty()),
  state: vb.exactOptional(
    vb.pipe(vb.picklist(["open", "closed"] as const), vb.description("New state")),
  ),
  title: vb.exactOptional(vb.pipe(vb.string(), vb.description("New title"))),
});

const githubUpdateIssue: ToolDef = {
  description: "Update an existing issue's title, body, state, or labels.",
  async execute(raw: unknown, ctx): Promise<ToolResult> {
    const { owner, repo, number, title, body, state, labels } = vb.parse(updateIssueSchema, raw);
    const payload: Record<string, unknown> = {};
    if (title !== undefined) {
      payload["title"] = title;
    }
    if (body !== undefined) {
      payload["body"] = body;
    }
    if (state !== undefined) {
      payload["state"] = state;
    }
    if (labels !== undefined) {
      payload["labels"] = labels;
    }

    const issue = await ghParse<GHIssue>(
      ctx,
      "PATCH",
      `/repos/${owner}/${repo}/issues/${String(number)}`,
      payload,
    );
    return {
      number: issue.number,
      state: issue.state,
      success: true,
      title: issue.title,
      url: issue.html_url,
    };
  },
  name: "github-update-issue",
  parameters: updateIssueSchema,
};

// ── github-search-issues ────────────────────────────────────────────

const searchIssuesSchema = vb.strictObject({
  limit: vb.exactOptional(
    vb.pipe(
      vb.number(),
      vb.integer(),
      vb.minValue(1),
      vb.maxValue(50),
      vb.description("Max results (default 10)"),
    ),
    10,
  ),
  query: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("Search query (supports GitHub qualifiers like repo:, label:, is:open)"),
  ),
});

const githubSearchIssues: ToolDef = {
  description: "Search for issues and pull requests across GitHub using full-text search.",
  async execute(raw: unknown, ctx): Promise<ToolResult> {
    const { limit, query } = vb.parse(searchIssuesSchema, raw);
    const params = new URLSearchParams();
    params.set("per_page", String(limit));
    params.set("q", query);
    const result = await ghParse<GHSearchResult<GHIssue>>(ctx, "GET", `/search/issues?${String(params)}`);
    const results = result.items.map((item) => ({
      htmlUrl: item.html_url,
      number: item.number,
      state: item.state,
      title: item.title,
      user: item.user?.login ?? undefined,
    }));
    return { results, success: true, totalCount: result.total_count };
  },
  name: "github-search-issues",
  parameters: searchIssuesSchema,
};

export const issueTools: Record<string, ToolDef> = {
  "github-create-issue": githubCreateIssue,
  "github-list-issues": githubListIssues,
  "github-read-issue": githubReadIssue,
  "github-search-issues": githubSearchIssues,
  "github-update-issue": githubUpdateIssue,
};
