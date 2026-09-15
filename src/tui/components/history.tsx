import { Box, Text } from "ink";
import React from "react";
import type { TimelineEntry } from "../types.js";
import { Banner } from "./banner.js";

export interface HistoryProps {
  entries: TimelineEntry[];
  version: string;
  workspacePath: string;
}

function HistoryLine({ entry }: { entry: Exclude<TimelineEntry, { kind: "banner" }> }) {
  if (entry.kind === "output") {
    return (
      <Box marginBottom={1}>
        <Text wrap="wrap">{entry.text}</Text>
      </Box>
    );
  }

  const styles = {
    user: { label: "you", color: "#D4AF37" },
    assistant: { label: "assistant", color: "#4EC9B0" },
    system: { label: "system", color: "gray" },
    tool: { label: "bash", color: "magenta" },
    error: { label: "error", color: "red" },
  } as const;
  const style = styles[entry.kind];

  return (
    <Box marginBottom={1}>
      <Box width={11} flexShrink={0}>
        <Text bold color={style.color}>
          {style.label}
        </Text>
      </Box>
      <Text wrap="wrap">{entry.text}</Text>
    </Box>
  );
}

export function History({ entries, version, workspacePath }: HistoryProps) {
  return (
    <Box width="100%" flexDirection="column">
      {entries.map((entry) =>
        entry.kind === "banner" ? (
          <Banner
            key={entry.id}
            version={version}
            modelName={entry.modelName}
            workspacePath={workspacePath}
          />
        ) : (
          <HistoryLine key={entry.id} entry={entry} />
        )
      )}
    </Box>
  );
}
