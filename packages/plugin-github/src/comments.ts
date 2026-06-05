import type { ToolDef, ToolResult } from "@cireilclaw/sdk";
import { vb } from "@cireilclaw/sdk";

import { ghParse } from "./api.js";
import type { GHComment } from "./types.js";

// ── github-add-issue-comment ────────────────────────────────────────

const addCommentSchema = vb.strictObject({
  body: vb.pipe(vb.string(), vb.nonEmpty(), vb.description("Comment body (Markdown)")),
  number: vb.pipe(vb.number(), vb.integer(), vb.minValue(1), vb.description("Issue or PR number")),
  owner: vb.pipe(vb.string(), vb.nonEmpty()),
  repo: vb.pipe(vb.string(), vb.nonEmpty()),
});

const githubAddIssueComment: ToolDef = {
  description: "Add a comment to an issue or pull request.",
  async execute(raw: unknown, ctx): Promise<ToolResult> {
    const { owner, repo, number, body } = vb.parse(addCommentSchema, raw);
    const comment = await ghParse<GHComment>(
      ctx,
      "POST",
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      { body },
    );
    return {
      htmlUrl: comment.html_url,
      id: comment.id,
      success: true,
    };
  },
  name: "github-add-issue-comment",
  parameters: addCommentSchema,
};

// ── github-list-issue-comments ──────────────────────────────────────

const listCommentsSchema = vb.strictObject({
  number: vb.pipe(vb.number(), vb.integer(), vb.minValue(1), vb.description("Issue or PR number")),
  owner: vb.pipe(vb.string(), vb.nonEmpty()),
  repo: vb.pipe(vb.string(), vb.nonEmpty()),
});

const githubListIssueComments: ToolDef = {
  description: "List comments on an issue or pull request.",
  async execute(raw: unknown, ctx): Promise<ToolResult> {
    const { owner, repo, number } = vb.parse(listCommentsSchema, raw);
    const items = await ghParse<GHComment[]>(
      ctx,
      "GET",
      `/repos/${owner}/${repo}/issues/${number}/comments`,
    );
    const comments = items.map((comment) => ({
      author: comment.user?.login ?? undefined,
      body: comment.body,
      createdAt: comment.created_at,
      htmlUrl: comment.html_url,
      id: comment.id,
      updatedAt: comment.updated_at,
    }));
    return { comments, success: true };
  },
  name: "github-list-issue-comments",
  parameters: listCommentsSchema,
};

export const commentTools: Record<string, ToolDef> = {
  "github-add-issue-comment": githubAddIssueComment,
  "github-list-issue-comments": githubListIssueComments,
};
