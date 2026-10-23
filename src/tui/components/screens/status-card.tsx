import {uiText} from '../../../localization/messages.js';
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
    return uiText('m0380be5a2ca8', {p0: Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "")});
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return uiText('m7be83ffa64de', {p0: Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1).replace(/\.0$/u, "")});
  }
  return value.toLocaleString("en-US");
}

function totalTokens(value: number, complete: boolean): string {
  if (!complete && value === 0) return uiText('me2f79e5b6033');
  return `${value.toLocaleString("en-US")}${complete ? "" : uiText('m9959721e6c5e')}`;
}

function cacheTokens(value: number | undefined, complete: boolean | undefined): string {
  if (value === undefined) return uiText('me2f79e5b6033');
  return `${value.toLocaleString("en-US")}${complete === true ? "" : uiText('m27f7a4cdb3c8')}`;
}

function cacheHitRate(snapshot: StatusSnapshot): string {
  if (
    snapshot.cached_input_tokens === undefined ||
    snapshot.cache_observed_input_tokens === undefined ||
    snapshot.cache_observed_input_tokens === 0
  ) return uiText('me2f79e5b6033');
  const rate = Math.round((snapshot.cached_input_tokens / snapshot.cache_observed_input_tokens) * 100);
  return `${Math.max(0, Math.min(100, rate))}%${snapshot.cache_usage_complete === true ? "" : uiText('m27f7a4cdb3c8')}`;
}

function contextStatus(snapshot: StatusSnapshot): string {
  if (snapshot.context_tokens === null) return uiText('me2f79e5b6033');
  if (snapshot.context_window === null) {
    return uiText('mb7bb26076850', {p0: compactTokens(snapshot.context_tokens)});
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
  return uiText('md6d455065c46', {p0: remaining, p1: compactTokens(snapshot.context_tokens), p2: compactTokens(snapshot.context_window)});
}

interface StatusField {
  label: string;
  value: string;
  truncateFromMiddle?: boolean;
}

function statusFields(snapshot: StatusSnapshot): StatusField[] {
  return [
    ...(snapshot.configuration_status ? [{ label: uiText('mb332c3492d5e'), value: snapshot.configuration_status }] : []),
    ...(snapshot.workflow_status ? [{ label: uiText('m7140f4f19dec'), value: snapshot.workflow_status }] : []),
    ...(snapshot.team_state ? [{ label: uiText('m5985039f106d'), value: snapshot.team_state }, { label: uiText('m1c7ba3a3ee3b'), value: totalTokens(snapshot.team_tokens ?? 0, snapshot.team_usage_complete ?? false) }] : []),
    { label: uiText('mdd167905de0d'), value: `v${snapshot.version}` },
    { label: uiText('m5e2c614c23f0'), value: snapshot.model_name ?? uiText('m5ad0f897690e') },
    { label: uiText('m472590ae974d'), value: snapshot.provider },
    { label: uiText('mcf0883343f4a'), value: snapshot.protocol ?? "responses" },
    { label: uiText('ma0ade140bc8e'), value: snapshot.compaction ?? uiText('me2f79e5b6033') },
    { label: uiText('md8211e24e83d'), value: snapshot.reasoning_effort ?? uiText('me2f79e5b6033') },
    { label: uiText('m15512289fa39'), value: snapshot.reasoning_sent ?? uiText('mcd5f943d5863') },
    { label: uiText('m821dad55cd9a'), value: snapshot.responses_profile ?? uiText('me2f79e5b6033') },
    { label: uiText('m52a4a227c5a7'), value: snapshot.capability_source ?? uiText('me2f79e5b6033') },
    {
      label: uiText('m70589413a3c9'),
      value: snapshot.base_url ?? uiText('me2f79e5b6033'),
      truncateFromMiddle: true,
    },
    {
      label: uiText('mc8f84c3c5378'),
      value: snapshot.workspace_path,
      truncateFromMiddle: true,
    },
    {
      label: uiText('m6959b4159575'),
      value: snapshot.session_id ?? uiText('m7a7400f46669'),
      truncateFromMiddle: true,
    },
    { label: uiText('m7696d0855331'), value: contextStatus(snapshot) },
    {
      label: uiText('mdd856eeb5046'),
      value: totalTokens(snapshot.input_tokens, snapshot.usage_complete),
    },
    {
      label: uiText('ma9b50ea0c4a7'),
      value: totalTokens(snapshot.output_tokens, snapshot.usage_complete),
    },
    {
      label: uiText('m157b0f67b442'),
      value: snapshot.reasoning_tokens === undefined ? "N/A" : snapshot.reasoning_tokens.toLocaleString("en-US"),
    },
    {
      label: uiText('m74f26d2d1cd9'),
      value: snapshot.auxiliary_input_tokens === undefined ? "N/A" : totalTokens(snapshot.auxiliary_input_tokens, snapshot.auxiliary_usage_complete ?? false),
    },
    {
      label: uiText('me9e33bdddfc8'),
      value: snapshot.auxiliary_output_tokens === undefined ? "N/A" : totalTokens(snapshot.auxiliary_output_tokens, snapshot.auxiliary_usage_complete ?? false),
    },
    {
      label: uiText('m876a4379087b'),
      value: cacheTokens(snapshot.cached_input_tokens, snapshot.cache_usage_complete),
    },
    {
      label: uiText('mcdc296c9c1f5'),
      value: cacheTokens(snapshot.cache_write_input_tokens, snapshot.cache_write_usage_complete),
    },
    { label: uiText('ma394d2c97531'), value: cacheHitRate(snapshot) },
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
