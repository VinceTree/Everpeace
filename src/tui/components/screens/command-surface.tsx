import {uiText,translateHostText} from '../../../localization/messages.js';
import { Spinner } from "@inkjs/ui";
import { Box, Text, useInput, useWindowSize } from "ink";
import React, { type ReactNode } from "react";
import type { StatusSnapshot } from "../../../status/model-status.js";
import { StatusDetails } from "./status-card.js";
import {TaskStatus}from'../conversation/task-status.js';
import type{TaskStatusSnapshot}from'../../../status/task-status.js';

export type CommandSurfaceTone = "default" | "error";

export const COMMAND_SCREEN_MAX_WIDTH = 80;
const COMMAND_SCREEN_FALLBACK_ROWS = 24;

export function commandScreenWidth(terminalColumns: number): number {
  return Math.max(1, Math.min(COMMAND_SCREEN_MAX_WIDTH, terminalColumns - 2));
}

export function CommandScreen({ children }: { children: ReactNode }) {
  const { columns, rows } = useWindowSize();
  const width = commandScreenWidth(columns);
  const terminalRows = Number.isFinite(rows) && rows > 0
    ? rows
    : COMMAND_SCREEN_FALLBACK_ROWS;

  return (
    <Box
      width="100%"
      minHeight={Math.max(1, terminalRows - 1)}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
    >
      <Box width={width} flexShrink={0} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}

export interface CommandSurfaceProps {
  title: string;
  tone?: CommandSurfaceTone;
  children: ReactNode;
  onBack?: () => void;
}

export function CommandSurface({
  title,
  tone = "default",
  children,
  onBack,
}: CommandSurfaceProps) {
  useInput((_input, key) => {
    if (key.escape) onBack?.();
  }, { isActive: onBack !== undefined });

  const color = tone === "error" ? "red" : "#D4AF37";
  return (
    <Box
      width="100%"
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={1}
    >
      <Text bold color={color}>{translateHostText(title)}</Text>
      <Box flexDirection="column" marginY={1}>
        {children}
      </Box>
      {onBack ? <Text dimColor>{uiText('m30c2566270e3')}</Text> : null}
    </Box>
  );
}

export interface CommandInfoSurfaceProps {
  title: string;
  text: string;
  tone?: CommandSurfaceTone;
  onBack(): void;
}

export function CommandInfoSurface({
  title,
  text,
  tone = "default",
  onBack,
}: CommandInfoSurfaceProps) {
  return (
    <CommandSurface title={title} tone={tone} onBack={onBack}>
      <Text {...(tone === "error" ? { color: "red" } : {})}>{translateHostText(text)}</Text>
    </CommandSurface>
  );
}

export function StatusSurface({
  snapshot,
  taskStatus,
  maxOutputTokens,
  onBack,
}: {
  snapshot: StatusSnapshot;
  taskStatus?:TaskStatusSnapshot;
  maxOutputTokens?:number;
  onBack(): void;
}) {
  return (
    <CommandSurface title={uiText('m03e23c1613d9')} onBack={onBack}>
      <StatusDetails snapshot={snapshot} />
      {taskStatus?<TaskStatus snapshot={taskStatus} details {...(maxOutputTokens!==undefined?{maxOutputTokens}:{})}/>:null}
    </CommandSurface>
  );
}

export function CommandLoadingSurface({
  title,
  label,
  onBack,
}: {
  title: string;
  label: string;
  onBack?: () => void;
}) {
  return (
    <CommandSurface
      title={title}
      {...(onBack === undefined ? {} : { onBack })}
    >
      <Spinner label={translateHostText(label)} />
    </CommandSurface>
  );
}
