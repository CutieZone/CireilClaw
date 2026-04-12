import { definePlugin, ToolError, vb } from "cireilclaw-sdk";

const ConfigSchema = vb.strictObject({
  apiKey: vb.union([
    vb.pipe(vb.string(), vb.nonEmpty()),
    vb.pipe(vb.array(vb.pipe(vb.string(), vb.nonEmpty())), vb.minLength(1)),
  ]),
});

const braveSearch = {
  description:
    "Search the web using Brave Search. Returns a list of results with titles, descriptions, and URLs.",
  name: "brave-search",
  parameters: vb.strictObject({
    count: vb.pipe(
      vb.exactOptional(vb.number(), 5),
      vb.description("Number of results to return (1-20, default 5)"),
    ),
    query: vb.pipe(vb.string(), vb.nonEmpty(), vb.description("The search query")),
  }),
  async execute(input: unknown, ctx: import("cireilclaw-sdk").PluginToolContext) {
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

    const data = (await response.json()) as {
      web?: { results?: { description?: string; title?: string; url?: string }[] };
    };

    const results = (data.web?.results ?? []).map((r) => ({
      description: r.description ?? "",
      title: r.title ?? "",
      url: r.url ?? "",
    }));

    return { query, results, success: true as const };
  },
};

export default definePlugin(() => ({ name: "brave-search", tools: { "brave-search": braveSearch } }));
