import { Select } from "@inkjs/ui";
import { Box, Text } from "ink";
import React from "react";
import type { SessionGoal } from "../../../storage/session-store.js";
import { CommandSurface } from "./command-surface.js";

export function GoalConfirmationSurface({ objective, tokenBudget, onConfirm, onCancel }: {
  objective: string;
  tokenBudget?: number;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <CommandSurface title="/goal · Confirm goal" onBack={onCancel}>
      <Text bold>Objective</Text>
      <Text>{objective}</Text>
      <Box marginTop={1}><Text>Request token budget: {tokenBudget?.toLocaleString() ?? "None"} (not a spending cap)</Text></Box>
      <Select options={[{ label: "Create and start", value: "start" }, { label: "Cancel", value: "cancel" }]} onChange={(value) => value === "start" ? onConfirm() : onCancel()} />
    </CommandSurface>
  );
}

export function GoalStatusSurface({ goal, onResume, onPause, onBack, inFlightRequests }: {
  goal?: SessionGoal;
  onResume(): void;
  onPause(): void;
  onBack(): void;
  inFlightRequests?: number;
}) {
  const options = goal?.status === "active"
    ? [{ label: "Pause goal", value: "pause" }, { label: "Back to session", value: "back" }]
    : goal && (goal.status === "paused" || goal.status === "blocked")
      ? [{ label: "Resume goal", value: "resume" }, { label: "Back to session", value: "back" }]
      : [{ label: "Back to session", value: "back" }];
  return (
    <CommandSurface title="/goal · Session goal" onBack={onBack}>
      {goal ? <Box flexDirection="column">
        <Text>Status: <Text color={goal.status === "active" ? "green" : "yellow"}>{goal.status}</Text></Text>
        <Text>Objective: {goal.objective}</Text>
        <Text>Request token budget: {goal.token_budget?.toLocaleString() ?? "None"} (not a spending cap)</Text>
        <Text>Known consumption: {goal.tokens_used.toLocaleString()} tokens · Metering: {goal.usage_complete === undefined ? "unknown" : goal.usage_complete ? "complete so far" : "incomplete"}</Text>
        <Text>In-flight requests: {inFlightRequests ?? "unavailable"}</Text>
        <Text>Elapsed: {Math.floor(goal.time_used_seconds)}s</Text>
      </Box> : <Text dimColor>No goal exists for this session.</Text>}
      <Select options={options} onChange={(value) => value === "pause" ? onPause() : value === "resume" ? onResume() : onBack()} />
    </CommandSurface>
  );
}
