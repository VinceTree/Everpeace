import {uiText} from '../../../localization/messages.js';
import { Box, Text, useWindowSize } from "ink";
import React from "react";
import {
  padEndToWidth,
  textWidth,
  truncateEnd,
  truncateMiddle,
} from "../../rendering/text-width.js";

const CYAN = "#4EC9B0";
const GOLD = "#D4AF37";
const JADE = "#2AA198";
const SESSION_CARD_MAX_INNER_WIDTH = 56;
const BRAND_CARD_INNER_WIDTH = 18;
const BRAND_TITLE = "長安 · 司矩";

interface SessionCard {
  top: string;
  model: string;
  directory: string;
  bottom: string;
  width: number;
}

export function createBrandCard(): [string, string, string] {
  const remainingWidth = BRAND_CARD_INNER_WIDTH - textWidth(BRAND_TITLE);
  const leftPadding = Math.floor(remainingWidth / 2);
  const rightPadding = remainingWidth - leftPadding;
  const horizontal = "═".repeat(BRAND_CARD_INNER_WIDTH);

  return [
    `╔${horizontal}╗`,
    `║${" ".repeat(leftPadding)}${BRAND_TITLE}${" ".repeat(rightPadding)}║`,
    `╚${horizontal}╝`,
  ];
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
  const model = modelName ?? uiText('m5ad0f897690e');
  const modelLine = truncateEnd(
    uiText('m40f950d1147b', {p0: model}),
    innerWidth,
  );
  const directoryPrefix = uiText('m29e0c248ad68');
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
  const brandCard = createBrandCard();

  return (
    <Box width="100%" flexDirection="column" marginBottom={1}>
      {wide ? (
        <Box gap={5}>
          <Text color={CYAN}>{`░█▀▀░█░█░█▀▀░█▀▄░█▀█░█▀▀░█▀█░█▀▀░█▀▀
░█▀▀░▀▄▀░█▀▀░█▀▄░█▀▀░█▀▀░█▀█░█░░░█▀▀
░▀▀▀░░▀░░▀▀▀░▀░▀░▀░░░▀▀▀░▀░▀░▀▀▀░▀▀▀`}</Text>
          <Text color={GOLD}>{brandCard.join("\n")}</Text>
        </Box>
      ) : (
        <Text bold color={CYAN}>
          {uiText('m89cab576407f')}<Text color={GOLD}>· 長安 · 司矩</Text>
        </Text>
      )}

      <Box marginTop={1}>
        <Text color={JADE}>✦ </Text>
        <Text bold>{uiText('m1d9ab417c54f')}</Text>
        <Text dimColor>{uiText('me01f7632e56c')}{version})</Text>
        <Text color={GOLD}> · </Text>
        <Text dimColor>天下长平，以规司矩</Text>
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
