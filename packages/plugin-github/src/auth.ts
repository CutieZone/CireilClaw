import { createPrivateKey, sign } from "node:crypto";

import type { PluginToolContext } from "@cireilclaw/sdk";
import { ToolError } from "@cireilclaw/sdk";

import { loadConfig } from "./config.js";

interface TokenEntry {
  token: string;
  expiresAt: number;
}

let cachedToken: TokenEntry | undefined = undefined;

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function generateJWT(appId: string, pem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256" as const, typ: "JWT" };
  const payload = {
    exp: now + 600,
    iat: now - 60,
    iss: appId,
  };

  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const key = createPrivateKey(pem);
  const signature = sign(undefined, Buffer.from(signingInput), key);

  return `${signingInput}.${signature.toString("base64url")}`;
}

export async function getInstallationToken(ctx: PluginToolContext): Promise<string> {
  // Return cached token if still valid with 2-minute buffer
  if (cachedToken !== undefined && cachedToken.expiresAt > Date.now() + 120_000) {
    return cachedToken.token;
  }

  const config = await loadConfig(ctx);
  const jwt = generateJWT(config.appId, config.privateKey);

  const response = await ctx.net.fetch(
    `https://api.github.com/app/installations/${config.installationId}/access_tokens`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "User-Agent": "cireilclaw-github-plugin",
      },
      method: "POST",
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new ToolError(`GitHub App auth failed (${response.status}): ${text}`);
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const data = (await response.json()) as { token: string; expires_at: string };
  cachedToken = {
    expiresAt: Date.parse(data.expires_at),
    token: data.token,
  };

  return data.token;
}
