import { Select } from "@inkjs/ui";
import { Box, Text, useInput, useWindowSize } from "ink";
import React from "react";
import type { SessionSummary } from "../../storage/session-store.js";
import { truncateEnd } from "../text-width.js";
import { commandScreenWidth } from "./command-surface.js";
import { translateLegacyUiText } from "../legacy-translation.js";

export interface SessionPickerProps {
  sessions: SessionSummary[];
  notice?: string;
  onSelect(session: SessionSummary): void;
  onCancel(): void;
}

function sessionLabel(session: SessionSummary, maximumWidth: number): string {
  const timestamp = new Date(session.updated_at).toLocaleString("en-US");
  return truncateEnd(`${translateLegacyUiText(session.title)} — ${timestamp}`, maximumWidth);
}

export function SessionPicker({
  sessions,
  notice,
  onSelect,
  onCancel,
}: SessionPickerProps) {
  const { columns } = useWindowSize();
  const labelWidth = Math.max(1, commandScreenWidth(columns) - 6);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) onCancel();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#D4AF37" paddingX={1}>
      <Text bold color="#D4AF37">Resume session</Text>
      {notice ? <Text color="yellow">{notice}</Text> : null}
      <Select
        options={sessions.map((session) => ({
          label: sessionLabel(session, labelWidth),
          value: session.id,
        }))}
        visibleOptionCount={Math.min(8, sessions.length)}
        onChange={(id) => {
          const session = sessions.find((candidate) => candidate.id === id);
          if (session) onSelect(session);
        }}
      />
      <Text dimColor>↑↓ select · Enter resume · Esc to return to session</Text>
    </Box>
  );
}
