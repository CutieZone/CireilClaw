import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { input } from "@inquirer/prompts";
import { buildCommand } from "@stricli/core";

import {
  createAuthorizationFlow,
  deleteCodexAuth,
  exchangeAuthorizationCode,
  getChatGptAccountId,
  getValidCodexAuth,
  parseAuthorizationInput,
  readCodexAuth,
  startLocalOAuthServer,
  writeCodexAuth,
} from "#engine/provider/openai-codex-auth.js";
import colors from "#output/colors.js";
import { info, warning } from "#output/log.js";

interface Flags {
  authId: string;
  logout?: boolean;
  status?: boolean;
}

function browserOpener(): string {
  if (process.platform === "darwin") {
    return "open";
  }
  if (process.platform === "win32") {
    return "start";
  }
  return "xdg-open";
}

function commandExists(command: string): boolean {
  if (process.platform === "win32" && command.toLowerCase() === "start") {
    return true;
  }

  const pathValue = process.env["PATH"] ?? "";
  for (const entry of pathValue.split(delimiter)) {
    if (entry.length === 0) {
      continue;
    }
    if (existsSync(join(entry, command))) {
      return true;
    }
  }
  return false;
}

function openBrowser(url: string): boolean {
  const opener = browserOpener();
  if (!commandExists(opener)) {
    return false;
  }
  try {
    const child = spawn(opener, [url], {
      shell: process.platform === "win32",
      stdio: "ignore",
    });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function printStatus(authId: string): Promise<void> {
  const auth = await readCodexAuth(authId);
  if (auth === undefined) {
    warning("No OpenAI Codex credentials found for", colors.keyword(authId));
    return;
  }

  const accountId = getChatGptAccountId(auth.accessToken);
  const expires = new Date(auth.expiresAt).toISOString();
  info("OpenAI Codex credentials", colors.keyword(authId));
  info("Account", colors.keyword(accountId ?? "unknown"));
  info("Access token expires", colors.keyword(expires));
}

async function run(flags: Flags): Promise<void> {
  if (flags.logout === true) {
    await deleteCodexAuth(flags.authId);
    info("Deleted OpenAI Codex credentials", colors.keyword(flags.authId));
    return;
  }

  if (flags.status === true) {
    await printStatus(flags.authId);
    return;
  }

  const flow = createAuthorizationFlow();
  const server = await startLocalOAuthServer(flow.state);

  info("Open this URL to authenticate OpenAI Codex:");
  info(flow.url);
  if (openBrowser(flow.url)) {
    info("Opened the URL in your browser.");
  }

  const serverResult = server.ready ? await server.waitForCode() : undefined;
  const serverCode = serverResult?.code;
  if (server.ready) {
    await server.close();
  }

  let code: string | undefined = serverCode;
  if (code === undefined) {
    if (!server.ready) {
      warning("Could not bind the local OAuth callback server. Falling back to manual paste.");
    }
    const pasted = await input({
      message: "Paste the full redirect URL or authorization code:",
      required: true,
    });
    const { code: parsedCode, state } = parseAuthorizationInput(pasted);
    if (state !== undefined && state !== flow.state) {
      throw new Error("OAuth state mismatch.");
    }
    code = parsedCode;
  }

  if (code === undefined || code.length === 0) {
    throw new Error("No authorization code received.");
  }

  const auth = await exchangeAuthorizationCode(code, flow.codeVerifier);
  await writeCodexAuth(flags.authId, auth);

  const validated = await getValidCodexAuth(flags.authId);
  const accountId = getChatGptAccountId(validated.accessToken);
  info("Stored OpenAI Codex credentials", colors.keyword(flags.authId));
  if (accountId !== undefined) {
    info("Account", colors.keyword(accountId));
  }
}

export const codexCommand = buildCommand({
  docs: {
    brief: "Authenticate the openai-codex provider with ChatGPT OAuth",
  },
  func: run,
  parameters: {
    flags: {
      authId: {
        brief: "Credential ID to create, inspect, or delete",
        default: "default",
        kind: "parsed",
        parse: String,
      },
      logout: {
        brief: "Delete stored credentials instead of logging in",
        kind: "boolean",
        optional: true,
      },
      status: {
        brief: "Show stored credential status instead of logging in",
        kind: "boolean",
        optional: true,
      },
    },
  },
});
