import type { ToolDef, ToolResult } from "@cireilclaw/sdk";
import { vb } from "@cireilclaw/sdk";

import { ghParse, ghParsePage } from "./api.js";
import type { GHRepo } from "./types.js";

// ── github-list-repos ───────────────────────────────────────────────

interface GHInstallationReposPage {
  repositories: GHRepo[];
  total_count: number;
}

const listReposSchema = vb.strictObject({
  page: vb.exactOptional(
    vb.pipe(vb.number(), vb.integer(), vb.minValue(1), vb.description("Page number (default: 1)")),
    1,
  ),
  perPage: vb.exactOptional(
    vb.pipe(
      vb.number(),
      vb.integer(),
      vb.minValue(1),
      vb.maxValue(100),
      vb.description("Results per page (max 100, default: 20)"),
    ),
    20,
  ),
});

const githubListRepos: ToolDef = {
  description: "List one bounded page of repositories the GitHub App installation can access.",
  async execute(raw: unknown, ctx): Promise<ToolResult> {
    const { page, perPage } = vb.parse(listReposSchema, raw);
    const result = await ghParsePage<GHInstallationReposPage>(
      ctx,
      "GET",
      `/installation/repositories?page=${String(page)}&per_page=${String(perPage)}`,
    );
    const repos = result.data.repositories.map((repo) => ({
      defaultBranch: repo.default_branch,
      description: repo.description,
      fullName: repo.full_name,
      htmlUrl: repo.html_url,
      language: repo.language,
      name: repo.name,
      owner: repo.owner?.login ?? undefined,
      private: repo.private,
      updatedAt: repo.updated_at,
    }));
    return {
      hasMore: result.hasMore,
      page,
      repos,
      success: true,
      totalCount: result.data.total_count,
    };
  },
  name: "github-list-repos",
  parameters: listReposSchema,
};

// ── github-read-repo ────────────────────────────────────────────────

const readRepoSchema = vb.strictObject({
  owner: vb.pipe(vb.string(), vb.nonEmpty()),
  repo: vb.pipe(vb.string(), vb.nonEmpty()),
});

const githubReadRepo: ToolDef = {
  description: "Get metadata about a repository.",
  async execute(raw: unknown, ctx): Promise<ToolResult> {
    const { owner, repo } = vb.parse(readRepoSchema, raw);
    const repoData = await ghParse<GHRepo>(ctx, "GET", `/repos/${owner}/${repo}`);
    return {
      defaultBranch: repoData.default_branch,
      description: repoData.description,
      fork: repoData.fork,
      forksCount: repoData.forks_count,
      fullName: repoData.full_name,
      htmlUrl: repoData.html_url,
      language: repoData.language,
      openIssuesCount: repoData.open_issues_count,
      owner: repoData.owner?.login ?? undefined,
      private: repoData.private,
      stargazersCount: repoData.stargazers_count,
      success: true,
      topics: repoData.topics,
      updatedAt: repoData.updated_at,
      visibility: repoData.visibility,
      watchersCount: repoData.watchers_count,
    };
  },
  name: "github-read-repo",
  parameters: readRepoSchema,
};

export const repoTools: Record<string, ToolDef> = {
  "github-list-repos": githubListRepos,
  "github-read-repo": githubReadRepo,
};
