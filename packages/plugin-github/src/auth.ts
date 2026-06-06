import { pemToDer, base64urlEncode, ToolError } from "@cireilclaw/sdk";
import type { PluginToolContext } from "@cireilclaw/sdk";

import { loadConfig } from "./config.js";

interface TokenEntry {
  token: string;
  expiresAt: number;
}

let cachedToken: TokenEntry | undefined = undefined;

async function generateJWT(
  appId: string,
  keyOrPath: string,
  ctx: PluginToolContext,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256" as const, typ: "JWT" };
  const payload = {
    exp: now + 600,
    iat: now - 60,
    iss: appId,
  };

  const encoder = new TextEncoder();
  const signingInput = [
    base64urlEncode(encoder.encode(JSON.stringify(header))),
    base64urlEncode(encoder.encode(JSON.stringify(payload))),
  ].join(".");

  // Normalize the key via the runtime (handles PKCS#1 → PKCS#8 auto-detection).
  const trimmed = keyOrPath.trim();
  const normalized = await ctx.crypto.loadNormalizedKey(
    trimmed.startsWith("-----BEGIN ") ? { data: trimmed } : { path: trimmed },
  );

  // Decode PEM to DER for Web Crypto import.
  const keyDer = pemToDer(normalized.data);

  // loadNormalizedKey returns "pkcs8" for private keys; signing requires private key.
  if (normalized.format !== "pkcs8") {
    throw new ToolError("GitHub plugin private key must be a private key");
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyDer as Uint8Array<ArrayBuffer>, // oxlint-disable-line typescript/no-unsafe-type-assertion
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(signingInput),
  );

  return `${signingInput}.${base64urlEncode(new Uint8Array(signature))}`;
}

export async function getInstallationToken(ctx: PluginToolContext): Promise<string> {
  // Return cached token if still valid with 2-minute buffer
  if (cachedToken !== undefined && cachedToken.expiresAt > Date.now() + 120_000) {
    return cachedToken.token;
  }

  const config = await loadConfig(ctx);
  const jwt = await generateJWT(config.appId, config.privateKey, ctx);

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
