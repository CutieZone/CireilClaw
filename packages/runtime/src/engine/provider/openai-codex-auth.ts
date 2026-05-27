import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { join } from "node:path";

import * as vb from "valibot";

import { root } from "#util/paths.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const REFRESH_SKEW_MS = 60_000;

const CodexAuthSchema = vb.object({
  accessToken: vb.pipe(vb.string(), vb.nonEmpty()),
  expiresAt: vb.pipe(vb.number(), vb.integer()),
  refreshToken: vb.pipe(vb.string(), vb.nonEmpty()),
});

type CodexAuth = vb.InferOutput<typeof CodexAuthSchema>;

interface AuthorizationFlow {
  codeVerifier: string;
  state: string;
  url: string;
}

interface ParsedAuthorizationInput {
  code?: string;
  state?: string;
}

interface LocalOAuthServer {
  close(): Promise<void>;
  ready: boolean;
  waitForCode(): Promise<{ code: string } | undefined>;
}

function validateAuthId(authId: string): void {
  if (!/^[A-Za-z0-9._-]+$/u.test(authId)) {
    throw new Error("OpenAI Codex authId may only contain letters, numbers, '.', '_', or '-'.");
  }
}

function codexAuthDir(): string {
  return join(root(), "config", "openai-codex");
}

function codexAuthPath(authId: string): string {
  validateAuthId(authId);
  return join(codexAuthDir(), `${authId}.json`);
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function createPkcePair(): { challenge: string; verifier: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { challenge, verifier };
}

function createAuthorizationFlow(): AuthorizationFlow {
  const pkce = createPkcePair();
  const state = randomBytes(16).toString("hex");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "codex_cli_rs");
  return { codeVerifier: pkce.verifier, state, url: url.toString() };
}

function parseAuthorizationInput(input: string): ParsedAuthorizationInput {
  const value = input.trim();
  if (value.length === 0) {
    return {};
  }

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Fall through to partial URL and raw-code formats.
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
}

async function tokenRequest(body: URLSearchParams): Promise<CodexAuth> {
  const response = await fetch(TOKEN_URL, {
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI Codex token request failed (${response.status}): ${text}`);
  }

  const json = vb.parse(
    vb.object({
      access_token: vb.pipe(vb.string(), vb.nonEmpty()),
      expires_in: vb.pipe(vb.number(), vb.integer()),
      refresh_token: vb.pipe(vb.string(), vb.nonEmpty()),
    }),
    await response.json(),
  );

  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    refreshToken: json.refresh_token,
  };
}

async function exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<CodexAuth> {
  return await tokenRequest(
    new URLSearchParams({
      client_id: CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
  );
}

async function refreshAccessToken(refreshToken: string): Promise<CodexAuth> {
  return await tokenRequest(
    new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
}

async function readCodexAuth(authId: string): Promise<CodexAuth | undefined> {
  const path = codexAuthPath(authId);
  if (!existsSync(path)) {
    return undefined;
  }
  return vb.parse(CodexAuthSchema, JSON.parse(await readFile(path, { encoding: "utf8" })));
}

async function writeCodexAuth(authId: string, auth: CodexAuth): Promise<void> {
  const dir = codexAuthDir();
  await mkdir(dir, { mode: 0o700, recursive: true });
  const path = codexAuthPath(authId);
  await writeFile(path, JSON.stringify(auth, undefined, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function deleteCodexAuth(authId: string): Promise<void> {
  await rm(codexAuthPath(authId), { force: true });
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  const [, payload] = parts;
  if (parts.length !== 3 || payload === undefined) {
    return undefined;
  }

  try {
    return vb.parse(
      vb.record(vb.string(), vb.unknown()),
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
  } catch {
    return undefined;
  }
}

function getChatGptAccountId(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const authClaim = payload?.[JWT_CLAIM_PATH];
  if (authClaim === null || typeof authClaim !== "object") {
    return undefined;
  }
  const parsed = vb.safeParse(vb.record(vb.string(), vb.unknown()), authClaim);
  if (!parsed.success) {
    return undefined;
  }
  const accountId = parsed.output["chatgpt_account_id"];
  return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
}

async function getValidCodexAuth(
  authId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<CodexAuth> {
  const current = await readCodexAuth(authId);
  if (current === undefined) {
    throw new Error(
      `OpenAI Codex OAuth credentials '${authId}' not found. Run 'cireilclaw codex --authId ${authId}'.`,
    );
  }

  if (options.forceRefresh !== true && current.expiresAt > Date.now() + REFRESH_SKEW_MS) {
    return current;
  }

  const refreshed = await refreshAccessToken(current.refreshToken);
  await writeCodexAuth(authId, refreshed);
  return refreshed;
}

async function unavailableClose(): Promise<void> {
  await Promise.resolve();
}

async function unavailableWaitForCode(): Promise<{ code: string } | undefined> {
  await Promise.resolve();
  return undefined;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

async function startLocalOAuthServer(state: string): Promise<LocalOAuthServer> {
  let lastCode: string | undefined = undefined;

  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== state) {
        response.statusCode = 400;
        response.end("State mismatch");
        return;
      }
      const code = url.searchParams.get("code");
      if (code === null || code.length === 0) {
        response.statusCode = 400;
        response.end("Missing authorization code");
        return;
      }
      lastCode = code;
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<h1>OpenAI Codex authentication complete</h1><p>You can close this tab.</p>");
    } catch {
      response.statusCode = 500;
      response.end("Internal error");
    }
  });

  return await new Promise((resolve) => {
    server.once("error", () => {
      resolve({
        close: unavailableClose,
        ready: false,
        waitForCode: unavailableWaitForCode,
      });
    });

    server.listen(1455, "127.0.0.1", () => {
      resolve({
        close: async () => {
          await closeServer(server);
        },
        ready: true,
        waitForCode: async () => {
          for (let idx = 0; idx < 6000; idx++) {
            if (lastCode !== undefined) {
              return { code: lastCode };
            }
            await sleep(100);
          }
          return undefined;
        },
      });
    });
  });
}

export {
  REDIRECT_URI,
  createAuthorizationFlow,
  deleteCodexAuth,
  exchangeAuthorizationCode,
  getChatGptAccountId,
  getValidCodexAuth,
  parseAuthorizationInput,
  readCodexAuth,
  startLocalOAuthServer,
  writeCodexAuth,
};
export type { AuthorizationFlow, CodexAuth, ParsedAuthorizationInput };
