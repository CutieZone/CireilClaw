import type { Agent } from "$/agent/index.js";
import { createHandler } from "$/channels/tui.js";
import { TuiBridge } from "$/channels/tui/bridge.js";
import { MessageLine } from "$/channels/tui/MessageLine.js";
import { StatusBar } from "$/channels/tui/StatusBar.js";
import { createTuiMessage } from "$/channels/tui/tui-message.js";
import type { TuiMessage } from "$/channels/tui/tui-message.js";
import type { UserMessage } from "$/engine/message.js";
import { TuiSession } from "$/harness/session.js";
import { Box, render, Static, Text, useApp } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";

interface AppProps {
  bridge: TuiBridge;
  agent: Agent;
}

function TuiApp({ bridge, agent }: AppProps): ReactElement {
  const { exit } = useApp();
  const [messages, setMessages] = useState<TuiMessage[]>(bridge.snapshot());
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

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

      let session = agent.sessions.get("tui");
      if (!(session instanceof TuiSession)) {
        session = new TuiSession(bridge);
        agent.sessions.set("tui", session);
      }

      session.history.push({
        content: { content: trimmed, type: "text" },
        role: "user",
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
    [agent, bridge, busy, exit],
  );

  return (
    <Box flexDirection="column">
      <Static items={messages}>{(msg) => <MessageLine key={msg.id} msg={msg} />}</Static>

      <StatusBar busy={busy} />
      <Box paddingX={1} paddingY={0}>
        <Text color="cyan" bold>
          {"›  "}
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          // oxlint-disable-next-line typescript/no-misused-promises
          onSubmit={handleSubmit}
          placeholder="say something..."
        />
      </Box>
    </Box>
  );
}

export async function startTui(agent: Agent): Promise<void> {
  const bridge = new TuiBridge();
  const handler = createHandler(bridge);

  agent.registerChannel("tui", handler);

  const inst = render(<TuiApp bridge={bridge} agent={agent} />);
  await inst.waitUntilExit();
}
