import type { PluginToolContext } from "@cireilclaw/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { issueTools } from "../../plugin-github/src/issues.js";
import type { GHIssue } from "../../plugin-github/src/types.js";

vi.mock("../../plugin-github/src/auth.js", () => ({
  getInstallationToken: vi.fn(async () => {
    await Promise.resolve();
    return "test-token";
  }),
}));

interface GitHubPage {
  hasMore: boolean;
  issues: GHIssue[];
}

const fetchMock = vi.fn<typeof fetch>();

const listIssues = issueTools["github-list-issues"];
if (listIssues === undefined) {
  throw new Error("github-list-issues tool is not registered");
}

function makeIssue(number: number, pullRequest = false): GHIssue {
  return {
    assignees: [],
    // oxlint-disable-next-line unicorn/no-null -- GitHub's API represents an absent body as null.
    body: null,
    comments: 0,
    created_at: "2026-08-26T00:00:00Z",
    html_url: `https://github.com/owner/repo/issues/${String(number)}`,
    labels: [],
    number,
    pull_request: pullRequest ? {} : undefined,
    state: "open",
    title: `Issue ${String(number)}`,
    updated_at: "2026-08-26T00:00:00Z",
    user: { login: "test-user" },
  };
}

function makeResponse(page: GitHubPage): Response {
  const headers = new Headers();
  if (page.hasMore) {
    headers.set("link", '<https://api.github.com/next>; rel="next"');
  }
  return Response.json(page.issues, { headers });
}

function inputUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

function setPages(pages: Readonly<Record<number, GitHubPage>>): void {
  fetchMock.mockImplementation(async (input) => {
    const url = inputUrl(input);
    const pageNumber = Number(url.searchParams.get("page"));
    const page = pages[pageNumber];
    if (page === undefined) {
      throw new Error(`Unexpected GitHub page: ${String(pageNumber)}`);
    }
    return await Promise.resolve(makeResponse(page));
  });
}

function makeContext(): PluginToolContext {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { net: { fetch: fetchMock } } as unknown as PluginToolContext;
}

function requestUrls(): URL[] {
  return fetchMock.mock.calls.map(([input]) => inputUrl(input));
}

describe("github-list-issues pagination", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("preserves filters on every underlying page request", async () => {
    setPages({
      1: { hasMore: true, issues: [makeIssue(10, true)] },
      2: { hasMore: false, issues: [makeIssue(1)] },
    });

    const result = await listIssues.execute(
      {
        assignee: "lyssieth",
        direction: "asc",
        labels: "bug,regression",
        owner: "owner",
        page: 1,
        perPage: 1,
        repo: "repo",
        sort: "updated",
        state: "all",
      },
      makeContext(),
    );

    expect(result).toMatchObject({
      hasMore: false,
      issues: [expect.objectContaining({ number: 1 })],
      page: 1,
      success: true,
    });
    for (const url of requestUrls()) {
      expect(url.searchParams.get("assignee")).toBe("lyssieth");
      expect(url.searchParams.get("direction")).toBe("asc");
      expect(url.searchParams.get("labels")).toBe("bug,regression");
      expect(url.searchParams.get("sort")).toBe("updated");
      expect(url.searchParams.get("state")).toBe("all");
    }
  });

  it("fills later logical pages from page one while skipping pull requests", async () => {
    setPages({
      1: { hasMore: true, issues: [makeIssue(99, true), makeIssue(1)] },
      2: { hasMore: true, issues: [makeIssue(2), makeIssue(3)] },
      3: { hasMore: false, issues: [makeIssue(4)] },
    });

    const result = await listIssues.execute(
      { owner: "owner", page: 2, perPage: 2, repo: "repo" },
      makeContext(),
    );

    expect(result).toMatchObject({
      hasMore: false,
      issues: [expect.objectContaining({ number: 3 }), expect.objectContaining({ number: 4 })],
      page: 2,
      success: true,
    });
    expect(requestUrls().map((url) => url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
  });

  it("reports more results when the final fetched page overfills the requested page", async () => {
    setPages({
      1: { hasMore: true, issues: [makeIssue(1), makeIssue(99, true)] },
      2: { hasMore: false, issues: [makeIssue(2), makeIssue(3)] },
    });

    const result = await listIssues.execute(
      { owner: "owner", page: 1, perPage: 2, repo: "repo" },
      makeContext(),
    );

    expect(result).toMatchObject({
      hasMore: true,
      issues: [expect.objectContaining({ number: 1 }), expect.objectContaining({ number: 2 })],
      page: 1,
      success: true,
    });
  });
});
