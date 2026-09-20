import { Box, Text } from "ink";
import React from "react";

/** Persistent one-line status shown only on the chat surface. */
export interface StatusBarProps {
  modelName: string | undefined;
  workspacePath: string;
  mode?: "default" | "plan";
  goalStatus?: string;
}

export function StatusBar({ modelName, workspacePath, mode = "default", goalStatus }: StatusBarProps) {
  const prefix = [mode === "plan" ? "Plan" : undefined, goalStatus ? `Goal: ${goalStatus}` : undefined].filter(Boolean).join(" · ");
  return (
    <Box
      width="100%"
      paddingX={1}
      gap={2}
      justifyContent="space-between"
    >
      <Text color={modelName ? "green" : "yellow"} wrap="truncate-end">
        {[prefix, modelName ?? "No model selected"].filter(Boolean).join(" · ")}
      </Text>
      <Text dimColor wrap="truncate-middle">
        {workspacePath}
      </Text>
    </Box>
  );
}
