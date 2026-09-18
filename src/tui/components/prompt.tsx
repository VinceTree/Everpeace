import { Box, Text, useInput, usePaste, useStdout } from "ink";
import React, { useMemo, useRef, useState } from "react";
import {
  filterSlashCommands,
  type SlashCommand,
} from "../commands.js";
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
import { characterWidth, textWidth } from "../text-width.js";

export interface PromptProps {
  historyNavigationRef?: React.RefObject<{ index: number | undefined; draft: string }>;
  editorRef?: React.RefObject<ComposerState>;
  history?: readonly string[];
  onEmptyInterrupt?(): void;
  activeModelName: string | undefined;
  disabled?: boolean;
  onSubmit(value: string): void;
}

const MAX_VISIBLE_LINES = 8;
const MAX_VISIBLE_SLASH_COMMANDS = 8;

interface ComposerLine {
  text: string;
  cursorColumn?: number;
}

interface SlashCommandMenuProps {
  commands: SlashCommand[];
  selectedIndex: number;
}

function SlashCommandMenu({ commands, selectedIndex }: SlashCommandMenuProps) {
  const firstVisibleIndex = Math.max(
    0,
    Math.min(
      selectedIndex - MAX_VISIBLE_SLASH_COMMANDS + 1,
      commands.length - MAX_VISIBLE_SLASH_COMMANDS,
    ),
  );
  const visibleCommands = commands.slice(
    firstVisibleIndex,
    firstVisibleIndex + MAX_VISIBLE_SLASH_COMMANDS,
  );

  return (
    <Box
      width="100%"
      flexDirection="column"
      backgroundColor="#111827"
      paddingX={1}
      overflow="hidden"
    >
      {visibleCommands.map((command, index) => {
        const isSelected = firstVisibleIndex + index === selectedIndex;
        return (
          <Box key={command} height={1} flexWrap="nowrap" overflow="hidden">
            <Text bold={isSelected} color={isSelected ? "#D4AF37" : "#D1D5DB"}>
              {isSelected ? "› " : "  "}
              {command}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
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
  history = [],
  onEmptyInterrupt,
  editorRef,
  historyNavigationRef,
}: PromptProps) {
  const localNavigation = useRef<{ index: number | undefined; draft: string }>({ index: undefined, draft: "" });
  const navigation = historyNavigationRef ?? localNavigation;
  const { stdout } = useStdout();
  const localStateRef = useRef<ComposerState>(createComposerState());
  const stateRef = editorRef ?? localStateRef;
  const [state, setState] = useState(stateRef.current);
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0);
  const [dismissedSlashCommandValue, setDismissedSlashCommandValue] = useState<
    string | undefined
  >();
  const placeholder = activeModelName
    ? "Ask Everpeace to do anything"
    : "Enter /login to get started";
  const updateState = (operation: (current: ComposerState) => ComposerState) => {
    const current = stateRef.current;
    const next = operation(current);
    stateRef.current = next;
    setState(next);
    if (next.value !== current.value) {
      setSelectedSlashCommandIndex(0);
      setDismissedSlashCommandValue(undefined);
    }
  };
  const matchingSlashCommands = useMemo(
    () => filterSlashCommands(state.value),
    [state.value],
  );
  const effectiveSlashCommandIndex = Math.min(
    selectedSlashCommandIndex,
    Math.max(0, matchingSlashCommands.length - 1),
  );
  const slashCommandMenuVisible =
    matchingSlashCommands.length > 0 && dismissedSlashCommandValue !== state.value;
  const selectedSlashCommand = slashCommandMenuVisible
    ? matchingSlashCommands[effectiveSlashCommandIndex]
    : undefined;

  usePaste((text) => updateState((current) => insertComposerText(current, text)), { isActive: !disabled });
  useInput(
    (input, key) => {
      if (key.eventType === "release") return;
      if (key.ctrl && input === "c") {
        if (stateRef.current.value) updateState(() => createComposerState());
        else onEmptyInterrupt?.();
        navigation.current.index = undefined;
        return;
      }

      if (key.return) {
        if (key.shift || key.meta || key.ctrl) {
          updateState((current) => insertComposerText(current, "\n"));
        } else {
          const submittedValue = selectedSlashCommand ?? stateRef.current.value;
          navigation.current = { index: undefined, draft: "" };
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

      if (slashCommandMenuVisible && (key.upArrow || (key.ctrl && input === "p"))) {
        setSelectedSlashCommandIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (slashCommandMenuVisible && (key.downArrow || (key.ctrl && input === "n"))) {
        setSelectedSlashCommandIndex((current) =>
          Math.min(matchingSlashCommands.length - 1, current + 1),
        );
        return;
      }
      if (slashCommandMenuVisible && key.tab && selectedSlashCommand) {
        const leadingWhitespace = stateRef.current.value.match(/^\s*/u)?.[0] ?? "";
        const completedValue = `${leadingWhitespace}${selectedSlashCommand}`;
        updateState(() => createComposerState(completedValue));
        setDismissedSlashCommandValue(completedValue);
        return;
      }
      if (slashCommandMenuVisible && key.escape) {
        setDismissedSlashCommandValue(stateRef.current.value);
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
        const current = stateRef.current;
        if (!Array.from(current.value).slice(0, current.cursor).includes("\n") && history.length) {
          if (navigation.current.index === undefined) navigation.current.draft = current.value;
          navigation.current.index = Math.max(0, (navigation.current.index ?? history.length) - 1);
          updateState(() => createComposerState(history[navigation.current.index!]!));
          setDismissedSlashCommandValue(history[navigation.current.index!]!);
          return;
        }
        updateState((current) => moveComposerVertically(current, -1));
        return;
      }
      if (key.downArrow || (key.ctrl && input === "n")) {
        const current = stateRef.current;
        if (navigation.current.index !== undefined && !Array.from(current.value).slice(current.cursor).includes("\n")) {
          navigation.current.index += 1;
          if (navigation.current.index >= history.length) {
            navigation.current.index = undefined;
            updateState(() => createComposerState(navigation.current.draft));
          } else {
            updateState(() => createComposerState(history[navigation.current.index!]!));
            setDismissedSlashCommandValue(history[navigation.current.index!]!);
          }
          return;
        }
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
    <Box width="100%" flexDirection="column">
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
      {slashCommandMenuVisible ? (
        <SlashCommandMenu
          commands={matchingSlashCommands}
          selectedIndex={effectiveSlashCommandIndex}
        />
      ) : null}
    </Box>
  );
}
