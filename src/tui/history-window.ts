import type { TimelineEntry } from "./types.js";

// These values mirror Codex's terminal-specific resize-reflow row caps.
export const DEFAULT_TERMINAL_RESIZE_REFLOW_MAX_ROWS = 1_000;
export const VSCODE_TERMINAL_RESIZE_REFLOW_MAX_ROWS = 1_000;
export const WINDOWS_TERMINAL_RESIZE_REFLOW_MAX_ROWS = 9_001;
export const WEZTERM_RESIZE_REFLOW_MAX_ROWS = 3_500;
export const ALACRITTY_RESIZE_REFLOW_MAX_ROWS = 10_000;

export interface HistoryWindowOptions {
  columns?: number;
  environment?: NodeJS.ProcessEnv;
  maxRows?: number;
}

export function terminalResizeReflowMaxRows(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const terminalProgram = environment.TERM_PROGRAM?.toLowerCase();

  if (environment.VSCODE_INJECTION !== undefined || terminalProgram === "vscode") {
    return VSCODE_TERMINAL_RESIZE_REFLOW_MAX_ROWS;
  }
  if (environment.WT_SESSION !== undefined || terminalProgram === "windows_terminal") {
    return WINDOWS_TERMINAL_RESIZE_REFLOW_MAX_ROWS;
  }
  if (terminalProgram === "wezterm") return WEZTERM_RESIZE_REFLOW_MAX_ROWS;
  if (terminalProgram === "alacritty") return ALACRITTY_RESIZE_REFLOW_MAX_ROWS;
  return DEFAULT_TERMINAL_RESIZE_REFLOW_MAX_ROWS;
}

function terminalCharacterWidth(character: string): number {
  const point = character.codePointAt(0) ?? 0;
  if (point <= 0x1f || (point >= 0x7f && point <= 0x9f)) return 0;
  if (
    point >= 0x1100 && (
      point <= 0x115f || point === 0x2329 || point === 0x232a ||
      (point >= 0x2e80 && point <= 0xa4cf) ||
      (point >= 0xac00 && point <= 0xd7a3) ||
      (point >= 0xf900 && point <= 0xfaff) ||
      (point >= 0xfe10 && point <= 0xfe19) ||
      (point >= 0xfe30 && point <= 0xfe6f) ||
      (point >= 0xff00 && point <= 0xff60) ||
      (point >= 0xffe0 && point <= 0xffe6) ||
      (point >= 0x1f300 && point <= 0x1faff)
    )
  ) return 2;
  return 1;
}

function terminalRows(text: string, columns: number): number {
  return text.split("\n").reduce((rows, line) => {
    const width = [...line].reduce(
      (total, character) => total + terminalCharacterWidth(character),
      0,
    );
    return rows + Math.max(1, Math.ceil(width / columns));
  }, 0);
}

function visibleOutputText(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= 6) return text;
  return [...lines.slice(0, 2), "output omitted", ...lines.slice(-4)].join("\n");
}

export function estimatedTimelineEntryRows(entry: TimelineEntry, columns: number): number {
  if (entry.kind === "banner") return columns >= 88 ? 11 : 9;
  if (entry.kind === "status") return 12;

  const contentColumns = Math.max(1, columns - 4);
  if (entry.kind === "user") {
    return terminalRows(entry.text, contentColumns) + 3;
  }
  if (entry.kind !== "output") {
    return terminalRows(entry.text, contentColumns) + 1;
  }

  let rows = 1; // The card's trailing margin.
  if (entry.command) {
    rows += 1;
    rows += terminalRows(entry.command.command, Math.max(1, columns - 1));
  }
  if (entry.text) {
    rows += terminalRows(visibleOutputText(entry.text), Math.max(1, columns - 4));
    if (entry.command) rows += 1;
  }
  return rows;
}

// Keep the source timeline intact for persistence, outputs and input navigation.
// Ink does not expose final layout measurements, so this uses the source text and
// current terminal columns to choose a conservative tail for source-backed replay.
export function visibleHistory(
  entries: TimelineEntry[],
  options: HistoryWindowOptions = {},
): TimelineEntry[] {
  const maxRows = options.maxRows ?? terminalResizeReflowMaxRows(options.environment);
  if (maxRows === 0 || entries.length === 0) return entries;

  const columns = Math.max(1, options.columns ?? 80);
  let firstVisible = entries.length;
  let rows = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entryRows = estimatedTimelineEntryRows(entries[index]!, columns);
    if (firstVisible !== entries.length && rows + entryRows > maxRows) break;
    rows += entryRows;
    firstVisible = index;
  }
  return firstVisible === 0 ? entries : entries.slice(firstVisible);
}
