import type { TuiMessage } from "$/channels/tui/tui-message.js";
import { Box, Text } from "ink";
import type { ReactElement } from "react";

export function MessageLine({ msg }: { msg: TuiMessage }): ReactElement {
  const time = msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (msg.role === "system") {
    return (
      <Text dimColor>
        {"  "}
        {time}
        {"  ⁕ "}
        {msg.content}
      </Text>
    );
  }

  const isUser = msg.role === "user";
  const label = isUser ? "you" : "agent";
  const color = isUser ? "cyan" : "magenta";

  return (
    <Box>
      <Text dimColor>{time} </Text>
      <Text color={color} bold>
        {label.padEnd(5)}
        {": "}
      </Text>
      <Text wrap="wrap">{msg.content}</Text>
    </Box>
  );
}
