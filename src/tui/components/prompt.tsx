import { Box, Text, useInput, useStdout } from "ink";
import React, { useMemo, useRef, useState } from "react";
import {
  createComposerState,
  deleteComposerBackward,
  deleteComposerForward,
  deleteComposerWordBackward,
  deleteComposerWordForward,
  insertComposerText,
  killComposerToLineEnd,
  killComposerToLineStart,
  moveComposerLeft,
  moveComposerLineEnd,
  moveComposerLineStart,
  moveComposerRight,
  moveComposerVertically,
  moveComposerWordLeft,
  moveComposerWordRight,
  yankComposer,
  type ComposerState,
} from "../composer/editor.js";

export interface PromptProps {
  activeModelName: string | undefined;
  disabled?: boolean;
  onSubmit(value: string): void;
}

const MAX_VISIBLE_LINES = 8;

function characterWidth(character: string): number {
  if (/^\p{Mark}+$/u.test(character)) return 0;
  if (/\p{Extended_Pictographic}/u.test(character)) return 2;
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  )
    ? 2
    : 1;
}

function textWidth(characters: string[]): number {
  return characters.reduce((width, character) => width + characterWidth(character), 0);
}

interface ComposerLine {
  text: string;
  cursorColumn?: number;
}

function composerLines(state: ComposerState): ComposerLine[] {
  const items = Array.from(state.value);
  const lines: ComposerLine[] = [];
  let start = 0;

  for (let index = 0; index <= items.length; index += 1) {
    if (index < items.length && items[index] !== "\n") continue;
    const lineItems = items.slice(start, index);
    const cursorOnLine = state.cursor >= start && state.cursor <= index;
    lines.push({
      text: lineItems.join(""),
      ...(cursorOnLine ? { cursorColumn: state.cursor - start } : {}),
    });
    start = index + 1;
  }

  return lines;
}

function clippedCursorLine(
  text: string,
  cursorColumn: number,
  maximumWidth: number,
): { before: string; cursor: string; after: string } {
  const items = Array.from(text);
  let start = 0;
  while (
    start < cursorColumn &&
    textWidth(items.slice(start, cursorColumn)) + characterWidth(items[cursorColumn] ?? " ") >
      maximumWidth
  ) {
    start += 1;
  }

  const cursor = items[cursorColumn] ?? " ";
  let end = cursorColumn + (cursorColumn < items.length ? 1 : 0);
  let used = textWidth(items.slice(start, end));
  if (cursorColumn === items.length) used += 1;
  while (end < items.length) {
    const width = characterWidth(items[end]!);
    if (used + width > maximumWidth) break;
    used += width;
    end += 1;
  }

  return {
    before: items.slice(start, cursorColumn).join(""),
    cursor,
    after: items.slice(cursorColumn + (cursorColumn < items.length ? 1 : 0), end).join(""),
  };
}

export function Prompt({
  activeModelName,
  disabled = false,
  onSubmit,
}: PromptProps) {
  const { stdout } = useStdout();
  const stateRef = useRef<ComposerState>(createComposerState());
  const [state, setState] = useState(stateRef.current);
  const placeholder = activeModelName
    ? "Ask Everpeace to do anything"
    : "输入 /login 开始";
  const updateState = (operation: (current: ComposerState) => ComposerState) => {
    const next = operation(stateRef.current);
    stateRef.current = next;
    setState(next);
  };

  useInput(
    (input, key) => {
      if (key.eventType === "release") return;

      if (key.return) {
        if (key.shift || key.meta || key.ctrl) {
          updateState((current) => insertComposerText(current, "\n"));
        } else {
          const submittedValue = stateRef.current.value;
          updateState(() => createComposerState());
          onSubmit(submittedValue);
        }
        return;
      }

      // Ctrl+J is distinguishable from Enter in legacy terminals. With the
      // enhanced keyboard protocol Ctrl+J/Ctrl+M arrive as named Ctrl keys.
      if (input === "\n" || (key.ctrl && (input === "j" || input === "m"))) {
        updateState((current) => insertComposerText(current, "\n"));
        return;
      }

      if (key.home || (key.ctrl && input === "a")) {
        updateState(moveComposerLineStart);
        return;
      }
      if (key.end || (key.ctrl && input === "e")) {
        updateState(moveComposerLineEnd);
        return;
      }
      if (key.leftArrow) {
        updateState(key.ctrl || key.meta ? moveComposerWordLeft : moveComposerLeft);
        return;
      }
      if (key.rightArrow) {
        updateState(key.ctrl || key.meta ? moveComposerWordRight : moveComposerRight);
        return;
      }
      if (key.upArrow || (key.ctrl && input === "p")) {
        updateState((current) => moveComposerVertically(current, -1));
        return;
      }
      if (key.downArrow || (key.ctrl && input === "n")) {
        updateState((current) => moveComposerVertically(current, 1));
        return;
      }
      if (key.backspace) {
        updateState(key.ctrl || key.meta ? deleteComposerWordBackward : deleteComposerBackward);
        return;
      }
      if (key.delete) {
        updateState(key.ctrl || key.meta ? deleteComposerWordForward : deleteComposerForward);
        return;
      }

      if (key.ctrl && key.meta && input === "h") {
        updateState(deleteComposerWordBackward);
        return;
      }

      if (key.ctrl) {
        const operation = {
          b: moveComposerLeft,
          d: deleteComposerForward,
          f: moveComposerRight,
          h: deleteComposerBackward,
          k: killComposerToLineEnd,
          u: killComposerToLineStart,
          w: deleteComposerWordBackward,
          y: yankComposer,
        }[input];
        if (operation) updateState(operation);
        return;
      }

      if (key.meta) {
        const operation = {
          b: moveComposerWordLeft,
          d: deleteComposerWordForward,
          f: moveComposerWordRight,
        }[input.toLowerCase()];
        if (operation) updateState(operation);
        return;
      }

      if (key.tab || key.escape || input === "[I" || input === "[O") return;
      if (input) updateState((current) => insertComposerText(current, input));
    },
    { isActive: !disabled },
  );

  const lines = useMemo(() => composerLines(state), [state]);
  const cursorLine = Math.max(
    0,
    lines.findIndex((line) => line.cursorColumn !== undefined),
  );
  const firstVisibleLine = Math.max(0, cursorLine - MAX_VISIBLE_LINES + 1);
  const visibleLines = lines.slice(firstVisibleLine, firstVisibleLine + MAX_VISIBLE_LINES);
  // Root padding, prompt padding, the marker and its gap consume five cells.
  const availableWidth = Math.max(1, (stdout.columns ?? 80) - 5);

  return (
    <Box
      width="100%"
      minHeight={3}
      backgroundColor="#1F2937"
      paddingX={1}
      paddingY={1}
      overflow="hidden"
      aria-role="textbox"
      aria-state={{ multiline: true }}
    >
      <Box width={2} flexShrink={0}>
        <Text bold color="#F8FAFC">
          ›
        </Text>
      </Box>
      <Box minWidth={0} flexGrow={1} flexDirection="column" overflow="hidden">
        {visibleLines.map((line, index) => {
          const absoluteLine = firstVisibleLine + index;
          const key = `${absoluteLine}:${line.text}`;
          if (line.cursorColumn === undefined) {
            return (
              <Box key={key} height={1} overflow="hidden">
                <Text wrap="truncate-end">{line.text || " "}</Text>
              </Box>
            );
          }

          if (state.value.length === 0) {
            return (
              <Box key={key} height={1} flexWrap="nowrap" overflow="hidden">
                <Text inverse> </Text>
                <Text color="#9CA3AF" wrap="truncate-end">
                  {placeholder}
                </Text>
              </Box>
            );
          }

          const clipped = clippedCursorLine(
            line.text,
            line.cursorColumn,
            availableWidth,
          );
          return (
            <Box key={key} height={1} flexWrap="nowrap" overflow="hidden">
              <Text wrap="truncate-end">
                {clipped.before}
                <Text inverse>{clipped.cursor}</Text>
                {clipped.after}
              </Text>
            </Box>
          );
        })}
        {firstVisibleLine + visibleLines.length < lines.length ? (
          <Text dimColor>…</Text>
        ) : null}
        {firstVisibleLine > 0 ? (
          <Box position="absolute" top={0} right={0}>
            <Text dimColor>…</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
