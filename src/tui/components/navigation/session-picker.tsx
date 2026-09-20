import { ConfirmInput, MultiSelect, Select, Spinner } from "@inkjs/ui";
import { Box, Text, useInput, useWindowSize } from "ink";
import React, { useState } from "react";
import type { SessionSummary } from "../../../storage/session-store.js";
import { truncateEnd } from "../../rendering/text-width.js";
import { commandScreenWidth } from "../screens/command-surface.js";
import { translateLegacyUiText } from "../../rendering/legacy-translation.js";

type SessionPickerMode = "resume" | "delete" | "confirm" | "deleting";

export interface SessionPickerProps {
  sessions: SessionSummary[];
  notice?: string;
  onSelect(session: SessionSummary): void;
  onDelete(sessionIds: string[]): void;
  onCancel(): void;
}

function sessionLabel(session: SessionSummary, maximumWidth: number): string {
  const timestamp = new Date(session.updated_at).toLocaleString("en-US");
  return truncateEnd(`${translateLegacyUiText(session.title)} — ${timestamp}`, maximumWidth);
}

export function SessionPicker({ sessions, notice, onSelect, onDelete, onCancel }: SessionPickerProps) {
  const { columns } = useWindowSize();
  const labelWidth = Math.max(1, commandScreenWidth(columns) - 6);
  const [mode, setMode] = useState<SessionPickerMode>("resume");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [error, setError] = useState<string>();

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      if (mode === "resume") onCancel();
      else if (mode === "confirm") setMode("delete");
      else if (mode !== "deleting") setMode("resume");
    }
  });

  const options = sessions.map((session) => ({
    label: sessionLabel(session, labelWidth),
    value: session.id,
  }));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#D4AF37" paddingX={1}>
      <Text bold color="#D4AF37">{mode === "resume" ? "Resume session" : "Delete sessions"}</Text>
      {notice ? <Text color="yellow">{notice}</Text> : null}
      {error ? <Text color="red">{error}</Text> : null}
      {mode === "resume" ? (
        <>
          <Select options={[...options, { label: "Delete sessions...", value: "__delete__" }]} visibleOptionCount={Math.min(8, sessions.length + 1)} onChange={(id) => { if (id === "__delete__") { setError(undefined); setMode("delete"); return; } const session = sessions.find((candidate) => candidate.id === id); if (session) onSelect(session); }} />
          <Text dimColor>↑↓ select · Enter resume · Choose Delete sessions to remove records · Esc to return</Text>
        </>
      ) : null}
      {mode === "delete" ? (
        <>
          <MultiSelect options={options} visibleOptionCount={Math.min(8, sessions.length)} onSubmit={(ids) => { if (ids.length === 0) { setError("Select at least one session"); return; } setSelectedIds(ids); setError(undefined); setMode("confirm"); }} />
          <Text dimColor>↑↓ move · Space select · Enter continue · Esc to return</Text>
        </>
      ) : null}
      {mode === "confirm" ? (
        <Box flexDirection="column">
          <Text color="yellow">Permanently delete {selectedIds.length} session{selectedIds.length === 1 ? "" : "s"}? This cannot be undone.</Text>
          <ConfirmInput defaultChoice="cancel" onConfirm={() => { setMode("deleting"); onDelete(selectedIds); }} onCancel={() => setMode("delete")} />
          <Text dimColor>Enter confirm · Esc cancel</Text>
        </Box>
      ) : null}
      {mode === "deleting" ? <Spinner label="Deleting sessions" /> : null}
    </Box>
  );
}
