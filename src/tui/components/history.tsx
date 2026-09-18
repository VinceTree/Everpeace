import { Box, Static, Text } from "ink";
import React from "react";
import type { TimelineEntry } from "../types.js";
import { Banner } from "./banner.js";
import { StatusCard } from "./status-card.js";
import { translateLegacyUiText } from "../legacy-translation.js";
import { TUI_COLORS } from "../palette.js";
import { HighlightedCommand, MarkdownText, RichOutput } from "./rich-text.js";

export interface HistoryProps {
  entries: TimelineEntry[];
  version: string;
  workspacePath: string;
}

function HistoryLine({
  entry,
}: {
  entry: Exclude<TimelineEntry, { kind: "banner" } | { kind: "status" }>;
}) {
  if (entry.kind === "user") {
    return (
      <Box
        width="100%"
        marginBottom={1}
        paddingX={1}
        paddingY={1}
        backgroundColor="#1F2937"
      >
        <Box width={2} flexShrink={0}>
          <Text color="#9CA3AF">›</Text>
        </Box>
        <Text wrap="wrap">{entry.text}</Text>
      </Box>
    );
  }

  if (entry.kind === "output") {
    const statusColor = entry.command?.status === "completed"
      ? TUI_COLORS.success
      : entry.command?.status === "failed"
        ? TUI_COLORS.error
        : TUI_COLORS.warning;
    const commandLabel = entry.command?.status === "cancelled"
      ? entry.command.source === "user" ? "You cancelled" : "Cancelled"
      : entry.command?.status === "failed"
        ? entry.command.source === "user" ? "Your command failed" : "Failed"
        : entry.command?.source === "user" ? "You ran" : "Ran";
    return (
      <Box marginBottom={1} paddingLeft={1} flexDirection="column">
        {entry.command ? <>
          <Text bold color={statusColor}>• {commandLabel} <Text color={TUI_COLORS.secondary}>{entry.command.shell}</Text> <Text dimColor>({(entry.command.durationMs / 1000).toFixed(1)}s{entry.command.truncated ? " · truncated" : ""})</Text></Text>
          <HighlightedCommand command={entry.command.command} shell={entry.command.shell} />
        </> : null}
        {entry.text ? <Box marginTop={entry.command ? 1 : 0}><Text dimColor>└ </Text><RichOutput text={entry.text} maximumLines={{ head: 2, tail: 4 }} /></Box> : null}
      </Box>
    );
  }

  const styles = {
    assistant: { marker: "•", color: TUI_COLORS.agent },
    system: { marker: "•", color: "gray" },
    tool: { marker: "•", color: "magenta" },
    error: { marker: "×", color: "red" },
  } as const;
  const style = styles[entry.kind];
  const text = entry.kind === "assistant" ? entry.text : translateLegacyUiText(entry.text);

  return (
    <Box marginBottom={1} paddingLeft={1}>
      <Box width={2} flexShrink={0}>
        <Text bold color={style.color}>
          {style.marker}
        </Text>
      </Box>
      {entry.kind === "assistant" ? <MarkdownText text={text} /> : <Text wrap="wrap">{text}</Text>}
    </Box>
  );
}

export function History({ entries, version, workspacePath }: HistoryProps) {
  return (
    <Static items={entries} style={{ width: "100%", flexDirection: "column" }}>
      {(entry) =>
        entry.kind === "banner" ? (
          <Banner
            key={entry.id}
            version={version}
            modelName={entry.modelName}
            workspacePath={workspacePath}
          />
        ) : entry.kind === "status" ? (
          <StatusCard key={entry.id} snapshot={entry.snapshot} />
        ) : (
          <HistoryLine key={entry.id} entry={entry} />
        )
      }
    </Static>
  );
}
