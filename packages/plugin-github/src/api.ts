import type { PluginToolContext } from "@cireilclaw/sdk";
import { ToolError } from "@cireilclaw/sdk";

import { getInstallationToken } from "./auth.js";

async function gh(
  ctx: PluginToolContext,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const token = await getInstallationToken(ctx);
  const url = new URL(path, "https://api.github.com");
  if (url.origin !== "https://api.github.com") {
    throw new ToolError("GitHub API request URL must stay on api.github.com");
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "cireilclaw-github-plugin",
    ...extraHeaders,
  };

  const options: RequestInit = { headers, method, redirect: "error" };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  return ctx.net.fetch(url, options);
}

function parseLinkNext(linkHeader: string | undefined): string | undefined {
  if (linkHeader === undefined) {
    return undefined;
  }

  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/u.exec(part.trim());
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return undefined;
}

async function ghParse<TData>(
  ctx: PluginToolContext,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<TData> {
  const response = await gh(ctx, method, path, body, extraHeaders);

  if (!response.ok) {
    const text = await response.text();
    throw new ToolError(`GitHub API error (${response.status}): ${text}`);
  }

  if (response.status === 204) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return {} as TData;
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (await response.json()) as TData;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
async function ghParsePage<TData>(
  ctx: PluginToolContext,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ data: TData; hasMore: boolean }> {
  const response = await gh(ctx, method, path, body, extraHeaders);

  if (!response.ok) {
    const text = await response.text();
    throw new ToolError(`GitHub API error (${response.status}): ${text}`);
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const data = (await response.json()) as TData;
  return {
    data,
    hasMore: parseLinkNext(response.headers.get("link") ?? undefined) !== undefined,
  };
}

export { gh, ghParse, ghParsePage, parseLinkNext };
