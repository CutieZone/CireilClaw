import type { ToolDef, ToolResult } from "@cireilclaw/sdk";
import { vb } from "@cireilclaw/sdk";

import { ghParse } from "./api.js";
import type { GHRepo, GHInstallationRepos } from "./types.js";

// ── github-list-repos ───────────────────────────────────────────────

const githubListRepos: ToolDef = {
  description: "List repositories the GitHub App installation has access to.",
  async execute(_raw: unknown, ctx): Promise<ToolResult> {
    const result = await ghParse<GHInstallationRepos>(ctx, "GET", "/installation/repositories");
    const repos = result.repositories.map((repo) => ({
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
    return { repos, success: true };
  },
  name: "github-list-repos",
  parameters: vb.strictObject({}),
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
