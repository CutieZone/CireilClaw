// GitHub REST API response shapes (snake_case matching API)

interface GHUser {
  login: string;
  [key: string]: unknown;
}

interface GHLabel {
  name: string;
  [key: string]: unknown;
}

interface GHLicense {
  key: string;
  name: string;
  spdx_id: string;
  [key: string]: unknown;
}

interface GHRepo {
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  private: boolean;
  fork: boolean;
  language: string | null;
  default_branch: string;
  visibility: string;
  owner: GHUser | null;
  topics: string[];
  forks_count: number;
  open_issues_count: number;
  stargazers_count: number;
  watchers_count: number;
  updated_at: string;
  [key: string]: unknown;
}

interface GHIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  body: string | null;
  comments: number;
  html_url: string;
  created_at: string;
  updated_at: string;
  labels: GHLabel[] | string[];
  assignees: GHUser[];
  user: GHUser | null;
  pull_request?: Record<string, unknown>;
  [key: string]: unknown;
}

interface GHPullRequest {
  number: number;
  title: string;
  state: "open" | "closed";
  body: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  additions: number;
  deletions: number;
  changed_files: number;
  comments: number;
  commits: number;
  user: GHUser | null;
  head: GHBranch;
  base: GHBranch;
  [key: string]: unknown;
}

interface GHBranch {
  ref: string;
  repo?: { full_name: string } | null;
  [key: string]: unknown;
}

interface GHPrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  blob_url: string;
  raw_url: string;
  contents_url: string;
  patch?: string;
  [key: string]: unknown;
}

interface GHComment {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: GHUser | null;
  [key: string]: unknown;
}

interface GHContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: "file" | "dir" | "symlink" | "submodule";
  content: string;
  encoding: string;
  html_url: string;
  [key: string]: unknown;
}

interface GHInstallationRepos {
  repositories: GHRepo[];
  total_count: number;
  [key: string]: unknown;
}

interface GHSearchResult<Item> {
  items: Item[];
  total_count: number;
  [key: string]: unknown;
}

interface GHCodeItem {
  name: string;
  path: string;
  html_url: string;
  repository?: { full_name: string } | null;
  [key: string]: unknown;
}

interface GHAccessToken {
  token: string;
  expires_at: string;
  [key: string]: unknown;
}

export type {
  GHAccessToken,
  GHBranch,
  GHCodeItem,
  GHComment,
  GHContent,
  GHInstallationRepos,
  GHIssue,
  GHLabel,
  GHLicense,
  GHPrFile,
  GHPullRequest,
  GHRepo,
  GHSearchResult,
  GHUser,
};
