import { Select } from "@inkjs/ui";
import { Box, Text } from "ink";
import React, { useState } from "react";
import type { LearnedMemoryStatus, LearnedScope } from "../../../memory/learned-memory.js";
import { CommandSurface } from "./command-surface.js";

export function MemorySurface({
  status,
  onBack,
  onToggle,
  onClear,
}: {
  status: LearnedMemoryStatus;
  onBack(): void;
  onToggle(enabled: boolean): void;
  onClear(scope: LearnedScope): void;
}) {
  const [confirmScope, setConfirmScope] = useState<LearnedScope>();
  const toggleLabel = status.enabled ? "Pause automatic learning" : "Resume automatic learning";
  if (confirmScope) {
    const label = confirmScope === "project" ? "project lessons" : "user preferences";
    return (
      <CommandSurface title="/memory · Confirm clear" onBack={onBack}>
        <Text color="yellow">Delete all {label}? This cannot be undone.</Text>
        <Select options={[
          { label: "Cancel", value: "cancel" },
          { label: `Clear ${label}`, value: "clear" },
        ]} onChange={(value) => {
          if (value === "clear") onClear(confirmScope);
          setConfirmScope(undefined);
        }} />
      </CommandSurface>
    );
  }

  return (
    <CommandSurface title="/memory · Learned experience" onBack={onBack}>
      <Box flexDirection="column">
        <Text>Automatic learning: <Text color={status.enabled ? "green" : "yellow"}>{status.enabled ? "enabled" : "paused"}</Text></Text>
        <Text>Project lessons: {status.projectEntries}</Text>
        <Text>User preferences: {status.userEntries}</Text>
      </Box>
      {status.recent.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Recent</Text>
          {status.recent.map((entry) => (
            <Text key={`${entry.createdAt}-${entry.scope}-${entry.lesson}`}>
              {entry.scope === "user" ? "user" : "project"}: {entry.lesson}
            </Text>
          ))}
        </Box>
      ) : <Box marginTop={1}><Text dimColor>No learned experience has been captured yet.</Text></Box>}
      <Select options={[
        { label: toggleLabel, value: "toggle" },
        { label: "Clear project lessons", value: "clear-project" },
        { label: "Clear user preferences", value: "clear-user" },
        { label: "Back to session", value: "back" },
      ]} onChange={(value) => {
        if (value === "toggle") onToggle(!status.enabled);
        if (value === "clear-project") setConfirmScope("project");
        if (value === "clear-user") setConfirmScope("user");
        if (value === "back") onBack();
      }} />
    </CommandSurface>
  );
}
