import { Box, Text } from "ink";
import React from "react";
import type { TaskProgress } from "../../../workflow/task-progress.js";

/** Persistent one-line status shown only on the chat surface. */
export interface StatusBarProps {
  modelName: string | undefined;
  workspacePath: string;
  mode?: "default" | "plan";
  goalStatus?: string;
  reasoningEffort?: "off" | "low" | "high" | "max";
  taskProgress?: TaskProgress;
}

export function StatusBar({ modelName, workspacePath, mode = "default", goalStatus, reasoningEffort, taskProgress }: StatusBarProps) {
  const completed = taskProgress?.plan.filter((item) => item.status === "completed").length ?? 0;
  const tasks = taskProgress?.plan.length ? `Tasks: ${completed}/${taskProgress.plan.length}` : undefined;
  const prefix = [mode === "plan" ? "Plan" : undefined, goalStatus ? `Goal: ${goalStatus}` : undefined, tasks].filter(Boolean).join(" · ");
  return (
    <Box
      width="100%"
      paddingX={1}
      gap={2}
      justifyContent="space-between"
    >
      <Text color={modelName ? "green" : "yellow"} wrap="truncate-end">
        {[prefix, modelName ?? "No model selected", modelName && reasoningEffort ? `reasoning ${reasoningEffort}` : undefined].filter(Boolean).join(" · ")}
      </Text>
      <Text dimColor wrap="truncate-middle">
        {workspacePath}
      </Text>
    </Box>
  );
}
