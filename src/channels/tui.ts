import { createRequire } from "node:module";

import { saveSession } from "$/db/sessions.js";
import type { Harness } from "$/harness/index.js";
import { TuiSession } from "$/harness/session.js";
import { setTuiSink } from "$/output/log.js";
import { onShutdown } from "$/util/shutdown.js";
import type blessed from "blessed";

// neo-blessed is CJS — use the same createRequire pattern as oceanic.js in discord.ts.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const bless = createRequire(import.meta.url)("neo-blessed") as typeof blessed;

// Strips the <msg ...>...</msg> wrapper that wraps user messages in history.
const MSG_TAG_RE = /^<msg\b[^>]*>([\s\S]*)<\/msg>$/;

function stripMsgWrapper(text: string): string {
  const match = MSG_TAG_RE.exec(text);
  return match?.[1] ?? text;
}

// Single-pass brace escaping so content cannot be misinterpreted as blessed tags.
function escapeBlessedTags(text: string): string {
  return text.replaceAll(/[{}]/g, (ch) => (ch === "{" ? "{open}" : "{close}"));
}

// Converts common Markdown constructs into blessed tags for terminal rendering.
function formatMarkdown(text: string): string {
  // Escape all braces first.
  let result = escapeBlessedTags(text);

  // Fenced code blocks: ```lang\ncode\n```
  result = result.replaceAll(/```(\w*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const label = lang ? ` ${lang} ` : "";
    return `\n{blue-fg}───${label}───{/}\n{yellow-fg}${code.trimEnd()}{/}\n{blue-fg}───{/}`;
  });

  // Inline code: `text`
  result = result.replaceAll(/`([^`]+)`/g, "{yellow-fg}$1{/}");

  // Bold: **text**
  result = result.replaceAll(/\*\*(.+?)\*\*/g, "{bold}$1{/bold}");

  // Italic: *text* — underline as terminal substitute (no italic in most terminals).
  result = result.replaceAll(/(?<!\*)\*([^*]+)\*(?!\*)/g, "{underline}$1{/}");

  // Headers: # text
  result = result.replaceAll(/^#{1,6}\s+(.+)$/gm, "{bold}{cyan-fg}$1{/}");

  return result;
}

// Renders existing session history into the chat log for continuity after restart.
function replayHistory(session: TuiSession, appendChat: (prefix: string, text: string) => void): void {
  for (const msg of session.history) {
    if (msg.role === "user") {
      const content = Array.isArray(msg.content) ? msg.content : [msg.content];
      for (const part of content) {
        if (part.type === "text") {
          appendChat("{cyan-fg}[you]{/}", escapeBlessedTags(stripMsgWrapper(part.content)));
        }
      }
    } else if (msg.role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : [msg.content];
      for (const part of content) {
        if (part.type === "text") {
          appendChat("{green-fg}[agent]{/}", formatMarkdown(part.content));
        } else if (part.type === "toolCall" && part.name === "respond") {
          // The agent's actual response text is in the respond tool call's input.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const input = part.input as Record<string, unknown> | undefined;
          if (input !== undefined && typeof input["content"] === "string") {
            appendChat("{green-fg}[agent]{/}", formatMarkdown(input["content"]));
          }
        }
      }
    }
  }
}

function startTui(harness: Harness, agentSlug: string): void {
  const agent = harness.agents.get(agentSlug);
  if (agent === undefined) {
    throw new Error(`Agent ${agentSlug} not found`);
  }

  // Find or create the TUI session.
  const sessionId = "tui:local";
  let session = agent.sessions.get(sessionId);
  if (session !== undefined && !(session instanceof TuiSession)) {
    throw new TypeError(`invalid session type: expected tui, got ${session.channel}`);
  }
  if (session === undefined) {
    session = new TuiSession("local");
    agent.sessions.set(sessionId, session);
  }

  // --- blessed screen setup ---
  const screen = bless.screen({
    autoPadding: true,
    fullUnicode: true,
    smartCSR: true,
    title: `cireilclaw - ${agentSlug}`,
  });

  // Destroy screen on shutdown so the terminal is restored properly.
  onShutdown(() => {
    screen.destroy();
  });

  // Suppress console output — logs still go to the file logger.
  setTuiSink(() => {
    // No-op: file logging still runs in log.ts regardless of sink.
  });

  // --- Status bar (top) ---
  const statusBar = bless.box({
    content: ` ${agentSlug}  |  ${sessionId}`,
    height: 1,
    left: 0,
    parent: screen,
    style: { bg: "blue", fg: "white" },
    tags: true,
    top: 0,
    width: "100%",
  });

  // --- Chat log (scrollable middle) ---
  const chatLog = bless.box({
    alwaysScroll: true,
    bottom: 3,
    keys: true,
    left: 0,
    mouse: true,
    parent: screen,
    scrollable: true,
    scrollbar: { ch: " ", style: { bg: "cyan" } },
    style: { bg: 235, fg: "white" },
    tags: true,
    top: 1,
    vi: true,
    width: "100%",
  });

  // --- Input box (bottom) ---
  const inputBox = bless.textarea({
    border: { type: "line" },
    bottom: 0,
    height: 3,
    inputOnFocus: true,
    left: 0,
    parent: screen,
    style: {
      bg: 235,
      border: { fg: "cyan" },
      fg: "white",
    },
    width: "100%",
  });

  inputBox.focus();
  screen.render();

  // --- Helpers ---

  function appendChat(prefix: string, text: string): void {
    const timestamp = new Date().toLocaleTimeString();
    chatLog.pushLine(`{grey-fg}${timestamp}{/} ${prefix} ${text}`);
    chatLog.setScrollPerc(100);
    screen.render();
  }

  function setThinking(thinking: boolean): void {
    const indicator = thinking ? " {yellow-fg}[thinking...]{/}" : "";
    statusBar.setContent(` ${agentSlug}  |  ${sessionId}${indicator}`);
    screen.render();
  }

  // --- Replay existing history on startup ---
  replayHistory(session, appendChat);

  // --- Register send/react handlers ---
  // oxlint-disable-next-line typescript/require-await
  agent.registerSend("tui", async (_session, content, _attachments) => {
    appendChat("{green-fg}[agent]{/}", formatMarkdown(content));
  });

  // oxlint-disable-next-line typescript/require-await
  agent.registerReact("tui", async (_session, emoji, _messageId) => {
    appendChat("{yellow-fg}[react]{/}", emoji);
  });

  // --- Input handling ---
  let processing = false;

  inputBox.key("enter", () => {
    const text = inputBox.getValue().trim();
    inputBox.clearValue();
    screen.render();

    if (text.length === 0) {
      return;
    }

    // /clear command — wipe conversation history and chat log, keep files/memories.
    if (text === "/clear") {
      session.history.length = 0;
      session.openedFiles.clear();
      session.pendingToolMessages.length = 0;
      session.pendingImages.length = 0;
      saveSession(agent.slug, session);
      chatLog.setContent("");
      appendChat("{yellow-fg}[system]{/}", "Conversation cleared.");
      return;
    }

    if (processing || session.busy) {
      appendChat("{red-fg}[system]{/}", "Please wait — agent is still processing.");
      return;
    }

    processing = true;
    appendChat("{cyan-fg}[you]{/}", escapeBlessedTags(text));

    session.history.push({
      content: {
        content: `<msg from="tui-user" timestamp="${new Date().toISOString()}">${text}</msg>`,
        type: "text",
      },
      persist: true,
      role: "user",
    });

    session.lastActivity = Date.now();
    session.busy = true;
    setThinking(true);

    const historyLengthBefore = session.history.length;

    // oxlint-disable-next-line promise/prefer-await-to-then,promise/catch-or-return
    agent
      .runTurn(session)
      // oxlint-disable-next-line promise/prefer-await-to-then
      .catch((error: unknown) => {
        session.history.length = historyLengthBefore;
        const reason = error instanceof Error ? error.message : String(error);
        appendChat("{red-fg}[error]{/}", reason);
      })
      // oxlint-disable-next-line promise/prefer-await-to-then
      .finally(() => {
        session.busy = false;
        processing = false;
        setThinking(false);
        saveSession(agent.slug, session);
        inputBox.focus();
        screen.render();
      });
  });

  // --- Keybindings ---
  screen.key(["escape", "C-c"], () => {
    screen.destroy();
    setTuiSink(undefined);
    process.kill(process.pid, "SIGINT");
  });
}

export { startTui };
