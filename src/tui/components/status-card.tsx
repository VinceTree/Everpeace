import { Box, Text, useWindowSize } from "ink";
import React from "react";
import type { StatusSnapshot } from "../../status/model-status.js";
import {
  padEndToWidth,
  textWidth,
  truncateEnd,
  truncateMiddle,
} from "../text-width.js";

const STATUS_CARD_MAX_INNER_WIDTH = 76;
const LABEL_WIDTH = 17;

export interface StatusCardLayout {
  lines: string[];
  width: number;
}

function compactTokens(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "")}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1).replace(/\.0$/u, "")}K`;
  }
  return value.toLocaleString("en-US");
}

function totalTokens(value: number, complete: boolean): string {
  if (!complete && value === 0) return "N/A";
  return `${value.toLocaleString("en-US")}${complete ? "" : "+ (partial)"}`;
}

function contextStatus(snapshot: StatusSnapshot): string {
  if (snapshot.context_tokens === null) return "N/A";
  if (snapshot.context_window === null) {
    return `${compactTokens(snapshot.context_tokens)} used / N/A`;
  }

  const remaining = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        ((snapshot.context_window - snapshot.context_tokens) /
          snapshot.context_window) *
          100,
      ),
    ),
  );
  return `${remaining}% left (${compactTokens(snapshot.context_tokens)} used / ${compactTokens(snapshot.context_window)})`;
}

function fitRow(
  label: string,
  value: string,
  innerWidth: number,
  truncateFromMiddle = false,
): string {
  const prefix = `${label}:`.padEnd(LABEL_WIDTH);
  const valueWidth = Math.max(0, innerWidth - textWidth(prefix));
  const fittedValue = truncateFromMiddle
    ? truncateMiddle(value, valueWidth)
    : truncateEnd(value, valueWidth);
  return padEndToWidth(`${prefix}${fittedValue}`, innerWidth);
}

export function createStatusCard(
  terminalColumns: number,
  snapshot: StatusSnapshot,
): StatusCardLayout | undefined {
  const availableWidth = Math.max(0, terminalColumns - 1);
  if (availableWidth < 4) return undefined;

  const innerWidth = Math.min(
    availableWidth - 4,
    STATUS_CARD_MAX_INNER_WIDTH,
  );
  const content = [
    fitRow("Version", `v${snapshot.version}`, innerWidth),
    fitRow("Model", snapshot.model_name ?? "not selected", innerWidth),
    fitRow("Provider", snapshot.provider, innerWidth),
    fitRow("Base URL", snapshot.base_url ?? "N/A", innerWidth, true),
    fitRow("Directory", snapshot.workspace_path, innerWidth, true),
    fitRow("Session", snapshot.session_id ?? "not started", innerWidth, true),
    fitRow("Context window", contextStatus(snapshot), innerWidth),
    fitRow(
      "Input tokens",
      totalTokens(snapshot.input_tokens, snapshot.usage_complete),
      innerWidth,
    ),
    fitRow(
      "Output tokens",
      totalTokens(snapshot.output_tokens, snapshot.usage_complete),
      innerWidth,
    ),
  ];
  const horizontal = "─".repeat(innerWidth + 2);
  return {
    lines: [
      `╭${horizontal}╮`,
      ...content.map((line) => `│ ${line} │`),
      `╰${horizontal}╯`,
    ],
    width: innerWidth + 4,
  };
}

export function StatusCard({ snapshot }: { snapshot: StatusSnapshot }) {
  const { columns } = useWindowSize();
  const card = createStatusCard(columns, snapshot);
  if (!card) return null;

  return (
    <Box
      width={card.width}
      height={card.lines.length}
      marginBottom={1}
      flexDirection="column"
      flexWrap="nowrap"
      overflow="hidden"
    >
      {card.lines.map((line, index) => (
        <Text
          key={`${index}:${line}`}
          dimColor={index === 0 || index === card.lines.length - 1}
        >
          {line}
        </Text>
      ))}
    </Box>
  );
}
