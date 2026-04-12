import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ReactElement } from "react";

export function StatusBar({ busy }: { busy: boolean }): ReactElement {
  return (
    <Box paddingX={1} height={1} flexShrink={1}>
      {busy ? (
        <Text color="yellow">
          <Spinner type="dots" />
          {" thinking..."}
        </Text>
      ) : (
        <Text dimColor>{"ready | /help for commands"}</Text>
      )}
    </Box>
  );
}
