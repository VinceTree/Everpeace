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
    return (
      <Box marginBottom={1} marginLeft={3}>
        <Text wrap="wrap">{entry.text}</Text>
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
