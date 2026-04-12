import { ToolError } from "$/engine/errors.js";
import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import { debug } from "$/output/log.js";
import { KeyPoolManager } from "$/util/key-pool.js";
import * as vb from "valibot";

const Schema = vb.strictObject({
  count: vb.pipe(
    vb.optional(vb.nullable(vb.pipe(vb.number(), vb.minValue(1), vb.maxValue(20)))),
    vb.transform((val) => val ?? 5),
    vb.description("Number of results to return (1–20, default 5)."),
  ),
  query: vb.pipe(vb.string(), vb.nonEmpty(), vb.description("Search query string.")),
});

interface BraveSearchResult {
  description: string;
  title: string;
  url: string;
}

interface BraveSearchResponse {
  web?: {
    results?: {
      description?: string;
      title?: string;
      url?: string;
    }[];
  };
}

function isBraveSearchResponse(value: unknown): value is BraveSearchResponse {
  return typeof value === "object" && value !== null;
}

export const braveSearch: ToolDef = {
  description:
    "Search the web via Brave Search and return a list of results. Each result contains a title, short description snippet, and URL.\n\n" +
    "This returns search result metadata only — not full page content. If you need to fetch the content of a page, you must use available binaries in the sandbox (like `curl` or `wget`) via the `exec` tool.\n\n" +
    "Use this when the user's request requires up-to-date information, facts, or references you don't have in context.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(Schema, input);
    const integrations = ctx.cfg.integrations;

    if (integrations.brave?.apiKey === undefined) {
      throw new ToolError("Brave Search is not configured. Add an API key to integrations.toml.");
    }

    const keyPool = KeyPoolManager.getPool(integrations.brave.apiKey);
    const params = new URLSearchParams();
    params.set("count", String(data.count ?? 5));
    params.set("q", data.query);

    // Track attempted keys to avoid infinite loops
    const attemptedKeys = new Set<string>();

    for (;;) {
      const apiKey = keyPool.getNextKey();

      // If we've already tried this key, all keys have been exhausted
      if (attemptedKeys.has(apiKey)) {
        throw new ToolError(
          "All Brave Search API keys have been rate-limited. Please try again later.",
        );
      }
      attemptedKeys.add(apiKey);

      const response = await fetch(
        `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
        {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
        },
      );

      // Check for rate limit (429) - try next key
      if (response.status === 429) {
        debug(`Rate limited (429) on Brave Search API key, trying next key...`);
        keyPool.reportFailure(apiKey);
        continue;
      }

      if (!response.ok) {
        throw new ToolError(`Brave Search API error: ${response.status} ${response.statusText}`);
      }

      const json = await response.json();
      if (!isBraveSearchResponse(json)) {
        throw new ToolError("Unexpected response format from Brave Search API");
      }

      const results: BraveSearchResult[] = [];

      for (const result of json.web?.results ?? []) {
        if (result.title !== undefined && result.url !== undefined) {
          results.push({
            description: result.description ?? "",
            title: result.title,
            url: result.url,
          });
        }
      }

      return { query: data.query, results, success: true };
    }
  },
  name: "brave-search",
  parameters: Schema,
};
