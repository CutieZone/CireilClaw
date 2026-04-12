import { definePlugin, ToolError, vb } from "cireilclaw-sdk";
import type { PluginToolContext, ToolResult } from "cireilclaw-sdk";

const ConfigSchema = vb.strictObject({
  apiKey: vb.union([
    vb.pipe(vb.string(), vb.nonEmpty()),
    vb.pipe(vb.array(vb.pipe(vb.string(), vb.nonEmpty())), vb.minLength(1)),
  ]),
});

const ResponseSchema = vb.looseObject({
  web: vb.exactOptional(
    vb.looseObject({
      results: vb.exactOptional(
        vb.array(
          vb.looseObject({
            description: vb.exactOptional(vb.string()),
            title: vb.exactOptional(vb.string()),
            url: vb.exactOptional(vb.string()),
          }),
        ),
        [],
      ),
    }),
  ),
});

const braveSearch = {
  description:
    "Search the web using Brave Search. Returns a list of results with titles, descriptions, and URLs.",
  async execute(input: unknown, ctx: PluginToolContext): Promise<ToolResult> {
    const { count, query } = vb.parse(this.parameters, input);

    const rawConfig = await ctx.cfg.globalPlugin("brave-search");
    if (rawConfig === undefined) {
      throw new ToolError(
        "Brave Search is not configured. Add an API key to config/plugins/brave-search.toml.",
      );
    }

    const config = vb.parse(ConfigSchema, rawConfig);
    const keyPool = ctx.createKeyPool(config.apiKey);
    const apiKey = keyPool.getNextKey();

    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("count", String(count));
    url.searchParams.set("q", query);

    const response = await fetch(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
    });

    if (response.status === 429) {
      keyPool.reportFailure(apiKey);
      throw new ToolError("Rate limited by Brave Search. Try again later.");
    }

    if (!response.ok) {
      throw new ToolError(`Brave Search API error: ${response.status} ${response.statusText}`);
    }

    const data = vb.parse(ResponseSchema, await response.json());

    const results = (data.web?.results ?? []).map((res) => ({
      description: res.description ?? "",
      title: res.title ?? "",
      url: res.url ?? "",
    }));

    return { query, results, success: true as const };
  },
  name: "brave-search",
  parameters: vb.strictObject({
    count: vb.pipe(
      vb.exactOptional(vb.number(), 5),
      vb.description("Number of results to return (1-20, default 5)"),
    ),
    query: vb.pipe(vb.string(), vb.nonEmpty(), vb.description("The search query")),
  }),
};

// oxlint-disable-next-line import/no-default-export
export default definePlugin(() => ({
  name: "brave-search",
  tools: { "brave-search": braveSearch },
}));
