import type { PluginToolContext } from "@cireilclaw/sdk";
import { ToolError, vb } from "@cireilclaw/sdk";

const ConfigSchema = vb.strictObject({
  appId: vb.pipe(vb.string(), vb.nonEmpty()),
  installationId: vb.union([
    vb.pipe(vb.string(), vb.nonEmpty()),
    vb.pipe(vb.number(), vb.integer(), vb.minValue(1)),
  ]),
  privateKey: vb.pipe(vb.string(), vb.nonEmpty()),
});

let cachedConfig: Config | undefined = undefined;
let loadPromise: Promise<Config> | undefined = undefined;

async function inner(ctx: Pick<PluginToolContext, "cfg">): Promise<Config> {
  const rawConfig = await ctx.cfg.globalPlugin("github");
  if (rawConfig === undefined) {
    throw new ToolError(
      "GitHub plugin is not configured. " +
        "Add appId, privateKey, and installationId to config/plugins/github.toml.",
    );
  }

  const parsed = vb.parse(ConfigSchema, rawConfig);

  return {
    appId: parsed.appId,
    installationId:
      typeof parsed.installationId === "string"
        ? Number.parseInt(parsed.installationId, 10)
        : parsed.installationId,
    privateKey: parsed.privateKey,
  };
}

export interface Config {
  appId: string;
  privateKey: string;
  installationId: number;
}

export async function loadConfig(ctx: Pick<PluginToolContext, "cfg">): Promise<Config> {
  if (cachedConfig !== undefined) {
    return cachedConfig;
  }

  if (loadPromise !== undefined) {
    return loadPromise;
  }

  loadPromise = inner(ctx);
  try {
    const config = await loadPromise;
    cachedConfig = config;
    return config;
  } finally {
    loadPromise = undefined;
  }
}
