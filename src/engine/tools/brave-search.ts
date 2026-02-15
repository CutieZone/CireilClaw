import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";

import { loadIntegrations } from "$/config/index.js";
import * as vb from "valibot";

const Schema = vb.strictObject({
  count: vb.exactOptional(vb.pipe(vb.number(), vb.minValue(1), vb.maxValue(20)), 5),
  query: vb.pipe(vb.string(), vb.nonEmpty()),
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

function hasApiKey(
  integrations: Awaited<ReturnType<typeof loadIntegrations>>,
): integrations is { brave: { apiKey: string } } {
  return integrations.brave?.apiKey !== undefined;
}

export const braveSearch: ToolDef = {
  description:
    "Search the web using Brave Search. Returns a list of results with title, description, and URL.",
  async execute(input: unknown, _ctx: ToolContext): Promise<Record<string, unknown>> {
    try {
      const data = vb.parse(Schema, input);
      const integrations = await loadIntegrations();

      if (!hasApiKey(integrations)) {
        return {
          error: "Brave Search is not configured. Add an API key to integrations.toml.",
          success: false,
        };
      }

      const params = new URLSearchParams();
      params.set("count", String(data.count));
      params.set("q", data.query);

      const response = await fetch(
        `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
        {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": integrations.brave.apiKey,
          },
        },
      );

      if (!response.ok) {
        return {
          error: `Brave Search API error: ${response.status} ${response.statusText}`,
          success: false,
        };
      }

      const json = await response.json();
      if (!isBraveSearchResponse(json)) {
        return { error: "Unexpected response format from Brave Search API", success: false };
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
    } catch (error: unknown) {
      if (error instanceof vb.ValiError) {
        return { error: error.message, issues: error.issues, success: false };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { error: message, success: false };
    }
  },
  name: "brave-search",
  parameters: Schema,
};
