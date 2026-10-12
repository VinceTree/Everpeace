import { Box, Text } from "ink";
import React from "react";
import type { TaskProgress } from "../../../workflow/task-progress.js";
import type { WorkflowState } from "../../../workflow/types.js";
import { CommandSurface } from "./command-surface.js";

function resultText(workflow: WorkflowState | undefined): string {
  if (!workflow) return "unavailable";
  return workflow.result
    ? `${workflow.result}${workflow.result_reason ? ` · ${workflow.result_reason}` : ""}`
    : workflow.phase;
}

export function TaskProgressSurface({ progress, workflow, onBack }: {
  progress: TaskProgress | undefined;
  workflow: WorkflowState | undefined;
  onBack(): void;
}) {
  return (
    <CommandSurface title="/tasks · Current task" onBack={onBack}>
      <Text>Last task result: {resultText(workflow)}</Text>
      <Box flexDirection="column" marginTop={1}>
        {!progress || progress.plan.length === 0 ? (
          <Text dimColor>No checklist is active for this task.</Text>
        ) : progress.plan.map((item, index) => (
          <Text key={`${index}:${item.step}`} {...(item.status === "completed" ? { color: "green" as const } : item.status === "in_progress" ? { color: "yellow" as const } : {})}>
            {item.status === "completed" ? "✓" : item.status === "in_progress" ? "●" : "○"} {item.step}
          </Text>
        ))}
      </Box>
      <Text dimColor>Checklist status is advisory; verification determines completion.</Text>
    </CommandSurface>
  );
}
