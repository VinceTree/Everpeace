import { Box, Text, useWindowSize } from "ink";
import React from "react";
import {
  padEndToWidth,
  truncateEnd,
  truncateMiddle,
} from "../../rendering/text-width.js";

const CYAN = "#4EC9B0";
const GOLD = "#D4AF37";
const JADE = "#2AA198";
const SESSION_CARD_MAX_INNER_WIDTH = 56;

interface SessionCard {
  top: string;
  model: string;
  directory: string;
  bottom: string;
  width: number;
}

export function createSessionCard(
  terminalColumns: number,
  modelName: string | undefined,
  workspacePath: string,
): SessionCard | undefined {
  // The app reserves the final terminal cell so Windows Terminal never
  // auto-wraps a line that exactly reaches the viewport edge.
  const availableWidth = Math.max(0, terminalColumns - 1);
  if (availableWidth < 4) return undefined;

  // Match Codex's session card: content is capped at 56 cells and the four
  // border/padding cells are accounted for before any text is rendered.
  const innerWidth = Math.min(
    availableWidth - 4,
    SESSION_CARD_MAX_INNER_WIDTH,
  );
  const model = modelName ?? "not selected";
  const modelLine = truncateEnd(
    `model:     ${model}   /model to change`,
    innerWidth,
  );
  const directoryPrefix = "directory: ";
  const directoryWidth = Math.max(0, innerWidth - directoryPrefix.length);
  const directoryLine = `${directoryPrefix}${truncateMiddle(
    workspacePath,
    directoryWidth,
  )}`;
  const horizontal = "─".repeat(innerWidth + 2);

  return {
    top: `╭${horizontal}╮`,
    model: `│ ${padEndToWidth(modelLine, innerWidth)} │`,
    directory: `│ ${padEndToWidth(directoryLine, innerWidth)} │`,
    bottom: `╰${horizontal}╯`,
    width: innerWidth + 4,
  };
}

export interface BannerProps {
  version: string;
  modelName: string | undefined;
  workspacePath: string;
}

export function Banner({ version, modelName, workspacePath }: BannerProps) {
  const { columns } = useWindowSize();
  const wide = columns >= 88;
  const sessionCard = createSessionCard(columns, modelName, workspacePath);

  return (
    <Box width="100%" flexDirection="column" marginBottom={1}>
      {wide ? (
        <Box gap={5}>
          <Text color={CYAN}>{`░█▀▀░█░█░█▀▀░█▀▄░█▀█░█▀▀░█▀█░█▀▀░█▀▀
░█▀▀░▀▄▀░█▀▀░█▀▄░█▀▀░█▀▀░█▀█░█░░░█▀▀
░▀▀▀░░▀░░▀▀▀░▀░▀░▀░░░▀▀▀░▀░▀░▀▀▀░▀▀▀`}</Text>
          <Text color={GOLD}>{`╔══════════════════╗
║ PEACE · ORDER    ║
╚══════════════════╝`}</Text>
        </Box>
      ) : (
        <Text bold color={CYAN}>
          EVERPEACE <Text color={GOLD}>· PEACE THROUGH ORDER</Text>
        </Text>
      )}

      <Box marginTop={1}>
        <Text color={JADE}>✦ </Text>
        <Text bold>Everpeace Agent </Text>
        <Text dimColor>(v{version})</Text>
        <Text color={GOLD}> · </Text>
        <Text dimColor>Peace through order</Text>
      </Box>

      {sessionCard ? (
        <Box
          width={sessionCard.width}
          height={4}
          marginTop={1}
          flexDirection="column"
          flexWrap="nowrap"
          overflow="hidden"
        >
          <Text dimColor>{sessionCard.top}</Text>
          <Text>{sessionCard.model}</Text>
          <Text>{sessionCard.directory}</Text>
          <Text dimColor>{sessionCard.bottom}</Text>
        </Box>
      ) : null}

    </Box>
  );
}
