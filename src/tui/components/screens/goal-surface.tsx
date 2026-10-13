import {uiText} from '../../../localization/messages.js';
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
    <CommandSurface title={uiText('m235f23877121')} onBack={onCancel}>
      <Text bold>{uiText('m3b20adc3b2ce')}</Text>
      <Text>{objective}</Text>
      <Box marginTop={1}><Text>{uiText('ma69b7920755b')}{tokenBudget?.toLocaleString() ?? uiText('mdc937b598926')}{uiText('mbb41ef444c1d')}</Text></Box>
      <Select options={[{ label: uiText('m6c90567a2724'), value: "start" }, { label: uiText('m19766ed6ccb2'), value: "cancel" }]} onChange={(value) => value === "start" ? onConfirm() : onCancel()} />
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
    ? [{ label: uiText('m27aa9fe4bc77'), value: "pause" }, { label: uiText('mdea785dbd445'), value: "back" }]
    : goal && (goal.status === "paused" || goal.status === "blocked")
      ? [{ label: uiText('m55a31a1f7e6c'), value: "resume" }, { label: uiText('mdea785dbd445'), value: "back" }]
      : [{ label: uiText('mdea785dbd445'), value: "back" }];
  return (
    <CommandSurface title={uiText('m049cf93cb25e')} onBack={onBack}>
      {goal ? <Box flexDirection="column">
        <Text>{uiText('m4889951f6134')}<Text color={goal.status === "active" ? "green" : "yellow"}>{goal.status}</Text></Text>
        <Text>{uiText('mc3b1664001b1')}{goal.objective}</Text>
        <Text>{uiText('ma69b7920755b')}{goal.token_budget?.toLocaleString() ?? uiText('mdc937b598926')}{uiText('mbb41ef444c1d')}</Text>
        <Text>{uiText('mfde9dd0f7189')}{goal.tokens_used.toLocaleString()}{uiText('mc739b11f285d')}{goal.usage_complete === undefined ? "unknown" : goal.usage_complete ? uiText('ma8494befa4c1') : "incomplete"}</Text>
        <Text>{uiText('m457d32258e10')}{inFlightRequests ?? "unavailable"}</Text>
        <Text>{uiText('m15d342cfd7fa')}{Math.floor(goal.time_used_seconds)}s</Text>
      </Box> : <Text dimColor>{uiText('me410fdf080ed')}</Text>}
      <Select options={options} onChange={(value) => value === "pause" ? onPause() : value === "resume" ? onResume() : onBack()} />
    </CommandSurface>
  );
}
