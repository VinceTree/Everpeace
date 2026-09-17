import { Box, Static, Text } from "ink";
import React from "react";
import type { TimelineEntry } from "../types.js";
import { Banner } from "./banner.js";
import { StatusCard } from "./status-card.js";

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
    const lines = entry.text.split("\n");
    const visible = lines.length > 6 ? [...lines.slice(0, 2), `... ${lines.length - 6} lines omitted (/outputs)`, ...lines.slice(-4)] : lines;
    return (
      <Box marginBottom={1} marginLeft={3} flexDirection="column">
        {entry.command ? <Text dimColor wrap="truncate-end">{entry.command.shell} · {entry.command.status} · {(entry.command.durationMs / 1000).toFixed(1)}s{entry.command.truncated ? " · truncated" : ""}</Text> : null}
        {visible.map((line, index) => (
          <Box key={`${index}:${line}`} height={1} overflow="hidden">
            <Text wrap="truncate-end">{line || " "}</Text>
          </Box>
        ))}
      </Box>
    );
  }

  const styles = {
    assistant: { marker: "•", color: "#9CA3AF" },
    system: { marker: "•", color: "gray" },
    tool: { marker: "•", color: "magenta" },
    error: { marker: "×", color: "red" },
  } as const;
  const style = styles[entry.kind];

  return (
    <Box marginBottom={1} paddingLeft={1}>
      <Box width={2} flexShrink={0}>
        <Text bold color={style.color}>
          {style.marker}
        </Text>
      </Box>
      <Text wrap="wrap">{entry.text}</Text>
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
