import { Select } from "@inkjs/ui";
import { Box, Text, useInput, useWindowSize } from "ink";
import React from "react";
import type { SessionSummary } from "../../storage/session-store.js";
import { truncateEnd } from "../text-width.js";

export interface SessionPickerProps {
  sessions: SessionSummary[];
  onSelect(session: SessionSummary): void;
  onCancel(): void;
}

function sessionLabel(session: SessionSummary, maximumWidth: number): string {
  const timestamp = new Date(session.updated_at).toLocaleString();
  return truncateEnd(`${session.title} — ${timestamp}`, maximumWidth);
}

export function SessionPicker({ sessions, onSelect, onCancel }: SessionPickerProps) {
  const { columns } = useWindowSize();
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) onCancel();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#D4AF37" paddingX={1}>
      <Text bold color="#D4AF37">恢复 Session</Text>
      <Select
        options={sessions.map((session) => ({
          label: sessionLabel(session, Math.max(12, columns - 8)),
          value: session.id,
        }))}
        visibleOptionCount={Math.min(8, sessions.length)}
        onChange={(id) => {
          const session = sessions.find((candidate) => candidate.id === id);
          if (session) onSelect(session);
        }}
      />
      <Text dimColor>↑↓ 选择 · Enter 恢复 · Esc 取消</Text>
    </Box>
  );
}
