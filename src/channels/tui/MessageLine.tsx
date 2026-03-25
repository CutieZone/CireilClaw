import type { TuiMessage } from "$/channels/tui/tui-message.js";
import { Box, Text } from "ink";
import type { ReactElement } from "react";

function wordWrap(text: string, width: number): string[] {
  if (width <= 0) {
    return [text];
  }
  if (text.length === 0) {
    return [""];
  } // Preserve empty lines

  const lines: string[] = [];
  let currentLine = "";

  for (const word of text.split(" ")) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (testLine.length <= width) {
      currentLine = testLine;
    } else {
      if (currentLine) {
        lines.push(currentLine);
      }
      // If single word is too long, break it
      if (word.length > width) {
        let remaining = word;
        while (remaining.length > width) {
          lines.push(remaining.slice(0, width));
          remaining = remaining.slice(width);
        }
        currentLine = remaining;
      } else {
        currentLine = word;
      }
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }
  return lines;
}

export function MessageLine({ msg }: { msg: TuiMessage }): ReactElement {
  const terminalWidth = process.stdout.columns;
  const time = msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (msg.role === "system") {
    const lines = msg.content.split("\n");
    return (
      <Box flexDirection="column">
        {lines.map((line, idx) => (
          <Text key={idx} dimColor>
            {idx === 0 ? (
              <>
                {"  "}
                {time}
                {"  ⁕ "}
                {line}
              </>
            ) : (
              <>
                {"     "}
                {line}
              </>
            )}
          </Text>
        ))}
      </Box>
    );
  }

  const isUser = msg.role === "user";
  const label = isUser ? "you" : "agent";
  const color = isUser ? "cyan" : "magenta";
  // Padding to align | with the : (time + space + label width)
  const colonAlignPadding = " ".repeat(5 + 1 + label.length);

  // Calculate prefix widths
  const firstLinePrefixWidth = 5 + 1 + label.length + 1 + 1; // time + space + label + : + space

  // Split by explicit newlines, then wrap each segment
  const explicitLines = msg.content.split("\n");
  const allLines: { text: string; isFirst: boolean; isFirstOfContent: boolean }[] = [];

  for (let idx = 0; idx < explicitLines.length; idx++) {
    const line = explicitLines[idx];
    if (line === undefined) {
      throw new Error("There is no way this should happen.");
    }

    const isFirstOfContent = idx === 0;
    const wrappedLines = wordWrap(line, terminalWidth - firstLinePrefixWidth);

    for (let jdx = 0; jdx < wrappedLines.length; jdx++) {
      const text = wrappedLines[jdx];
      if (text === undefined) {
        throw new Error("There is no way this should happen.");
      }

      allLines.push({
        isFirst: jdx === 0,
        isFirstOfContent,
        text,
      });
    }
  }

  return (
    <Box flexDirection="column">
      {allLines.map(({ text, isFirst, isFirstOfContent }, idx) => (
        <Box key={idx}>
          {isFirstOfContent && isFirst ? (
            <>
              <Text dimColor>{time}</Text>
              <Text> </Text>
              <Text color={color} bold>
                {label}
                {":"}
              </Text>
              <Text> </Text>
            </>
          ) : (
            <>
              <Text dimColor>{colonAlignPadding}</Text>
              <Text color={color} bold>
                {"|"}
              </Text>
              <Text> </Text>
            </>
          )}
          <Text>{text}</Text>
        </Box>
      ))}
    </Box>
  );
}
