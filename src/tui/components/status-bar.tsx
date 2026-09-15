import { Box, Text } from "ink";
import React from "react";

export interface StatusBarProps {
  modelName: string | undefined;
  workspacePath: string;
}

export function StatusBar({ modelName, workspacePath }: StatusBarProps) {
  return (
    <Box
      width="100%"
      paddingX={1}
      gap={2}
      justifyContent="space-between"
    >
      <Text color={modelName ? "green" : "yellow"} wrap="truncate-end">
        {modelName ?? "未选择模型"}
      </Text>
      <Text dimColor wrap="truncate-middle">
        {workspacePath}
      </Text>
    </Box>
  );
}
