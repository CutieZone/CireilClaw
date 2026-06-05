import type { PluginToolContext } from "@cireilclaw/sdk";
import { ToolError } from "@cireilclaw/sdk";

import { getInstallationToken } from "./auth.js";

async function gh(
  ctx: PluginToolContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const token = await getInstallationToken(ctx);
  const url = new URL(path, "https://api.github.com");

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "cireilclaw-github-plugin",
  };

  const options: RequestInit = { headers, method };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  return ctx.net.fetch(url, options);
}

async function ghParse<TData>(
  ctx: PluginToolContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<TData> {
  const response = await gh(ctx, method, path, body);

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

export { gh, ghParse };

