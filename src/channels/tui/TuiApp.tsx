import type { Agent } from "$/agent/index.js";
import { createHandler } from "$/channels/tui.js";
import { TuiBridge } from "$/channels/tui/bridge.js";
import { MessageLine } from "$/channels/tui/MessageLine.js";
import { StatusBar } from "$/channels/tui/StatusBar.js";
import { createTuiMessage } from "$/channels/tui/tui-message.js";
import type { TuiMessage } from "$/channels/tui/tui-message.js";
import type { UserMessage } from "$/engine/message.js";
import { NamedInternalSession, TuiSession } from "$/harness/session.js";
import { Box, render, Static, Text, useApp } from "ink";
import { MultilineInput } from "ink-multiline-input";
import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";

interface AppProps {
  bridge: TuiBridge;
  agent: Agent;
  initialSessionId: string;
}

function TuiApp({ bridge, agent, initialSessionId }: AppProps): ReactElement {
  const { exit } = useApp();
  const [messages, setMessages] = useState<TuiMessage[]>(bridge.snapshot());
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  // Calculate rows based on input content (min 1, max 10)
  const inputRows = Math.max(1, Math.min(10, input.split("\n").length));

  useEffect(() => {
    function onMessage(msg: TuiMessage): void {
      setMessages((prev) => [...prev, msg]);
    }

    bridge.on("message", onMessage);
    // oxlint-disable-next-line no-void
    return (): void => void bridge.off("message", onMessage);
  }, [bridge]);

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (trimmed.length === 0 || busy) {
        return;
      }
      setInput("");

      if (trimmed.startsWith("/")) {
        const [cmd] = trimmed.slice(1).split(" ");
        // oxlint-disable-next-line typescript/switch-exhaustiveness-check
        switch (cmd) {
          case "quit":
          case "exit":
            exit();
            // oxlint-disable-next-line unicorn/no-process-exit
            process.exit(0);
            break;
          case "clear":
            setMessages([]);
            break;
          case "help":
            bridge.push(createTuiMessage("system", "commands: /quit  /help  /clear"));
            break;
          default:
            bridge.push(createTuiMessage("system", `unknown command: /${cmd}`));
            break;
        }
        return;
      }

      bridge.push(createTuiMessage("user", trimmed));
      setBusy(true);

      let session = agent.sessions.get(initialSessionId);
      if (session === undefined) {
        if (initialSessionId.startsWith("internal:")) {
          session = new NamedInternalSession(initialSessionId.slice("internal:".length));
        } else {
          session = new TuiSession(bridge);
        }
        agent.sessions.set(initialSessionId, session);
      } else if (session instanceof TuiSession) {
        // Update bridge if it's an existing TUI session
        session.bridge = bridge;
      }

      session.history.push({
        content: { content: trimmed, type: "text" },
        role: "user",
        timestamp: Date.now(),
      } as UserMessage);

      try {
        await agent.runTurn(session);
      } catch (error: unknown) {
        bridge.push(
          createTuiMessage(
            "system",
            `error: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      } finally {
        setBusy(false);
      }
    },
    [agent, bridge, busy, exit, initialSessionId],
  );

  return (
    <Box flexDirection="column">
      <Static items={messages}>{(msg) => <MessageLine key={msg.id} msg={msg} />}</Static>

      <StatusBar busy={busy} />
      <Box paddingX={1} paddingY={0}>
        <Text color="cyan" bold>
          {"›  "}
        </Text>
        <MultilineInput
          value={input}
          onChange={setInput}
          // oxlint-disable-next-line typescript/no-misused-promises
          onSubmit={handleSubmit}
          placeholder="say something... (Enter to send, Shift+Enter for newline)"
          rows={inputRows}
          maxRows={10}
          keyBindings={{
            newline: (key) => key.return && key.shift,
            submit: (key) => key.return && !key.shift,
          }}
        />
      </Box>
    </Box>
  );
}

export async function startTui(agent: Agent, initialSessionId = "tui"): Promise<void> {
  const bridge = new TuiBridge();
  const handler = createHandler(bridge);

  agent.registerChannel("tui", handler);

  const inst = render(<TuiApp agent={agent} bridge={bridge} initialSessionId={initialSessionId} />);
  await inst.waitUntilExit();
}
