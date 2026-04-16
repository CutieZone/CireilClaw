import { definePlugin, ToolError, vb } from "@cireilclaw/sdk";
import type { PluginToolContext, ToolResult } from "@cireilclaw/sdk";

const ConfigSchema = vb.strictObject({
  apiKey: vb.union([
    vb.pipe(vb.string(), vb.nonEmpty()),
    vb.pipe(vb.array(vb.pipe(vb.string(), vb.nonEmpty())), vb.minLength(1)),
  ]),
});

const UnitsSchema = vb.exactOptional(
  vb.union([vb.literal("metric"), vb.literal("imperial"), vb.literal("standard")]),
  "metric",
);

async function loadConfig(ctx: PluginToolContext): Promise<{ apiKey: string | string[] }> {
  const rawConfig = await ctx.cfg.globalPlugin("openweather");
  if (rawConfig === undefined) {
    throw new ToolError(
      "OpenWeatherMap is not configured. Add an API key to config/plugins/openweather.toml.",
    );
  }
  return vb.parse(ConfigSchema, rawConfig);
}

function formatTemp(value: number, units: string): string {
  const symbols: Record<string, string> = {
    imperial: "°F",
    metric: "°C",
    standard: "K",
  };
  const symbol = symbols[units];
  return `${value}${symbol ?? "K"}`;
}

function formatSpeed(value: number, units: string): string {
  const symbol = units === "imperial" ? "mph" : "m/s";
  return `${value} ${symbol}`;
}

const CurrentWeatherSchema = vb.looseObject({
  dt: vb.optional(vb.number()),
  main: vb.optional(
    vb.looseObject({
      feels_like: vb.optional(vb.number()),
      humidity: vb.optional(vb.number()),
      pressure: vb.optional(vb.number()),
      temp: vb.optional(vb.number()),
      temp_max: vb.optional(vb.number()),
      temp_min: vb.optional(vb.number()),
    }),
  ),
  name: vb.optional(vb.string()),
  sys: vb.optional(
    vb.looseObject({
      country: vb.optional(vb.string()),
      sunrise: vb.optional(vb.number()),
      sunset: vb.optional(vb.number()),
    }),
  ),
  visibility: vb.optional(vb.number()),
  weather: vb.optional(
    vb.array(
      vb.looseObject({
        description: vb.optional(vb.string()),
        main: vb.optional(vb.string()),
      }),
    ),
  ),
  wind: vb.optional(
    vb.looseObject({
      deg: vb.optional(vb.number()),
      speed: vb.optional(vb.number()),
    }),
  ),
});

const weather = {
  description: "Get current weather conditions for a location using OpenWeatherMap.",
  async execute(input: unknown, ctx: PluginToolContext): Promise<ToolResult> {
    const { location, units } = vb.parse(this.parameters, input);
    const config = await loadConfig(ctx);
    const keyPool = ctx.createKeyPool(config.apiKey);
    const apiKey = keyPool.getNextKey();

    const url = new URL("https://api.openweathermap.org/data/2.5/weather");
    url.searchParams.set("q", location);
    url.searchParams.set("units", units);
    url.searchParams.set("appid", apiKey);

    const response = await ctx.net.fetch(url);

    if (response.status === 429) {
      keyPool.reportFailure(apiKey);
      throw new ToolError("Rate limited by OpenWeatherMap. Try again later.");
    }

    if (!response.ok) {
      throw new ToolError(`OpenWeatherMap API error: ${response.status} ${response.statusText}`);
    }

    const raw = await response.json();
    const data = vb.parse(CurrentWeatherSchema, raw);

    const condition = data.weather?.[0];
    const country = data.sys?.country === undefined ? "" : `, ${data.sys.country}`;

    return {
      description: condition?.description ?? condition?.main ?? "Unknown",
      feelsLike:
        data.main?.feels_like === undefined ? undefined : formatTemp(data.main.feels_like, units),
      humidity: data.main?.humidity,
      location: `${data.name ?? location}${country}`,
      pressure: data.main?.pressure,
      success: true,
      temp: data.main?.temp === undefined ? undefined : formatTemp(data.main.temp, units),
      tempMax:
        data.main?.temp_max === undefined ? undefined : formatTemp(data.main.temp_max, units),
      tempMin:
        data.main?.temp_min === undefined ? undefined : formatTemp(data.main.temp_min, units),
      visibility: data.visibility,
      windDeg: data.wind?.deg,
      windSpeed: data.wind?.speed === undefined ? undefined : formatSpeed(data.wind.speed, units),
    };
  },
  name: "weather",
  parameters: vb.strictObject({
    location: vb.pipe(
      vb.string(),
      vb.nonEmpty(),
      vb.description("City name, optionally with country code (e.g. 'London' or 'London,UK')"),
    ),
    units: vb.pipe(
      UnitsSchema,
      vb.description("Units: metric (°C), imperial (°F), or standard (K). Default: metric."),
    ),
  }),
};

const ForecastItemSchema = vb.looseObject({
  dt: vb.optional(vb.number()),
  dt_txt: vb.optional(vb.string()),
  main: vb.optional(
    vb.looseObject({
      feels_like: vb.optional(vb.number()),
      humidity: vb.optional(vb.number()),
      temp: vb.optional(vb.number()),
    }),
  ),
  pop: vb.optional(vb.number()),
  weather: vb.optional(
    vb.array(
      vb.looseObject({
        description: vb.optional(vb.string()),
        main: vb.optional(vb.string()),
      }),
    ),
  ),
  wind: vb.optional(
    vb.looseObject({
      speed: vb.optional(vb.number()),
    }),
  ),
});

const ForecastSchema = vb.looseObject({
  city: vb.optional(
    vb.looseObject({
      country: vb.optional(vb.string()),
      name: vb.optional(vb.string()),
    }),
  ),
  list: vb.optional(vb.array(ForecastItemSchema)),
});

const forecast = {
  description: "Get a 5-day / 3-hour weather forecast for a location using OpenWeatherMap.",
  async execute(input: unknown, ctx: PluginToolContext): Promise<ToolResult> {
    const { location, units } = vb.parse(this.parameters, input);
    const config = await loadConfig(ctx);
    const keyPool = ctx.createKeyPool(config.apiKey);
    const apiKey = keyPool.getNextKey();

    const url = new URL("https://api.openweathermap.org/data/2.5/forecast");
    url.searchParams.set("q", location);
    url.searchParams.set("units", units);
    url.searchParams.set("appid", apiKey);

    const response = await ctx.net.fetch(url);

    if (response.status === 429) {
      keyPool.reportFailure(apiKey);
      throw new ToolError("Rate limited by OpenWeatherMap. Try again later.");
    }

    if (!response.ok) {
      throw new ToolError(`OpenWeatherMap API error: ${response.status} ${response.statusText}`);
    }

    const raw = await response.json();
    const data = vb.parse(ForecastSchema, raw);

    const cityName = data.city?.name ?? location;
    const country = data.city?.country === undefined ? "" : `, ${data.city.country}`;

    const periods = (data.list ?? []).slice(0, 8).map((item) => {
      const condition = item.weather?.[0];
      return {
        datetime: item.dt_txt,
        description: condition?.description ?? condition?.main ?? "Unknown",
        feelsLike:
          item.main?.feels_like === undefined ? undefined : formatTemp(item.main.feels_like, units),
        humidity: item.main?.humidity,
        precipitationChance: item.pop,
        temp: item.main?.temp === undefined ? undefined : formatTemp(item.main.temp, units),
        windSpeed: item.wind?.speed === undefined ? undefined : formatSpeed(item.wind.speed, units),
      };
    });

    return {
      location: `${cityName}${country}`,
      periods,
      success: true,
    };
  },
  name: "forecast",
  parameters: vb.strictObject({
    location: vb.pipe(
      vb.string(),
      vb.nonEmpty(),
      vb.description("City name, optionally with country code (e.g. 'London' or 'London,UK')"),
    ),
    units: vb.pipe(
      UnitsSchema,
      vb.description("Units: metric (°C), imperial (°F), or standard (K). Default: metric."),
    ),
  }),
};

// oxlint-disable-next-line import/no-default-export
export default definePlugin(() => ({
  name: "openweather",
  tools: { forecast, weather },
}));
