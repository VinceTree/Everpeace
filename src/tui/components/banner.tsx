import { Box, Text, useWindowSize } from "ink";
import React from "react";

const CYAN = "#4EC9B0";
const GOLD = "#D4AF37";
const JADE = "#2AA198";

export interface BannerProps {
  version: string;
  modelName: string | undefined;
  workspacePath: string;
}

export function Banner({ version, modelName, workspacePath }: BannerProps) {
  const { columns } = useWindowSize();
  const wide = columns >= 88;

  return (
    <Box width="100%" flexDirection="column" marginBottom={1}>
      {wide ? (
        <Box gap={5}>
          <Text color={CYAN}>{`░█▀▀░█░█░█▀▀░█▀▄░█▀█░█▀▀░█▀█░█▀▀░█▀▀
░█▀▀░▀▄▀░█▀▀░█▀▄░█▀▀░█▀▀░█▀█░█░░░█▀▀
░▀▀▀░░▀░░▀▀▀░▀░▀░▀░░░▀▀▀░▀░▀░▀▀▀░▀▀▀`}</Text>
          <Text color={GOLD}>{`╔══════════════════╗
║  長 安 · 司 矩   ║
╚══════════════════╝`}</Text>
        </Box>
      ) : (
        <Text bold color={CYAN}>
          EVERPEACE <Text color={GOLD}>· 長安司矩</Text>
        </Text>
      )}

      <Box marginTop={1}>
        <Text color={JADE}>✦ </Text>
        <Text bold>Everpeace Agent </Text>
        <Text dimColor>(v{version})</Text>
        <Text color={GOLD}> · </Text>
        <Text dimColor>天下长平，以规司矩</Text>
      </Box>

      <Box
        width={76}
        maxWidth="100%"
        flexShrink={1}
        marginTop={1}
        paddingX={1}
        flexDirection="column"
        borderStyle="round"
        borderColor="#6B7280"
      >
        <Text wrap="truncate-end">
          <Text dimColor>model: </Text>
          <Text color={modelName ? "green" : "yellow"}>
            {modelName ?? "not selected"}
          </Text>
          <Text dimColor>  /model to change</Text>
        </Text>
        <Text wrap="truncate-middle">
          <Text dimColor>directory: </Text>
          {workspacePath}
        </Text>
      </Box>

    </Box>
  );
}
