import { Box, Text, useWindowSize } from "ink";
import React from "react";
import type { StatusSnapshot } from "../../../status/model-status.js";
import {
  padEndToWidth,
  textWidth,
  truncateEnd,
  truncateMiddle,
} from "../../rendering/text-width.js";

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

function cacheTokens(value: number | undefined, complete: boolean | undefined): string {
  if (complete !== true || value === undefined) return "N/A";
  return value.toLocaleString("en-US");
}

function cacheHitRate(snapshot: StatusSnapshot): string {
  if (
    snapshot.cache_usage_complete !== true ||
    snapshot.cached_input_tokens === undefined ||
    snapshot.input_tokens === 0
  ) return "N/A";
  const rate = Math.round((snapshot.cached_input_tokens / snapshot.input_tokens) * 100);
  return `${Math.max(0, Math.min(100, rate))}%`;
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

interface StatusField {
  label: string;
  value: string;
  truncateFromMiddle?: boolean;
}

function statusFields(snapshot: StatusSnapshot): StatusField[] {
  return [
    { label: "Version", value: `v${snapshot.version}` },
    { label: "Model", value: snapshot.model_name ?? "not selected" },
    { label: "Provider", value: snapshot.provider },
    {
      label: "Base URL",
      value: snapshot.base_url ?? "N/A",
      truncateFromMiddle: true,
    },
    {
      label: "Directory",
      value: snapshot.workspace_path,
      truncateFromMiddle: true,
    },
    {
      label: "Session",
      value: snapshot.session_id ?? "not started",
      truncateFromMiddle: true,
    },
    { label: "Context window", value: contextStatus(snapshot) },
    {
      label: "Input tokens",
      value: totalTokens(snapshot.input_tokens, snapshot.usage_complete),
    },
    {
      label: "Output tokens",
      value: totalTokens(snapshot.output_tokens, snapshot.usage_complete),
    },
    {
      label: "Cached input",
      value: cacheTokens(snapshot.cached_input_tokens, snapshot.cache_usage_complete),
    },
    {
      label: "Cache writes",
      value: cacheTokens(snapshot.cache_write_input_tokens, snapshot.cache_usage_complete),
    },
    { label: "Cache hit rate", value: cacheHitRate(snapshot) },
  ];
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
  const content = statusFields(snapshot).map((field) =>
    fitRow(
      field.label,
      field.value,
      innerWidth,
      field.truncateFromMiddle,
    ),
  );
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

export function StatusDetails({ snapshot }: { snapshot: StatusSnapshot }) {
  const { columns } = useWindowSize();
  const contentWidth = Math.max(1, columns - 5);
  const labelWidth = Math.min(LABEL_WIDTH, Math.max(1, Math.floor(contentWidth / 2)));

  return (
    <Box width="100%" flexDirection="column">
      {statusFields(snapshot).map((field) => (
        <Box
          key={field.label}
          width="100%"
          height={1}
          flexWrap="nowrap"
          overflow="hidden"
        >
          <Box width={labelWidth} flexShrink={0} overflow="hidden">
            <Text wrap="truncate-end">{`${field.label}:`}</Text>
          </Box>
          <Box flexGrow={1} overflow="hidden">
            <Text wrap={field.truncateFromMiddle ? "truncate-middle" : "truncate-end"}>
              {field.value}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
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
