import {uiText} from '../../localization/messages.js';
import { Box, Text, useInput, usePaste, useWindowSize } from "ink";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  filterSlashCommands,
  type SlashCommand,
} from "../commands/slash-commands.js";
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
} from "./editor.js";
import { characterWidth, textWidth } from "../rendering/text-width.js";
import {
  activeFileReferenceQuery,
  parseFileReferences,
  quotedFileReference,
} from "../../agent/file-attachments.js";

export interface PromptProps {
  historyNavigationRef?: React.RefObject<{ index: number | undefined; draft: string }>;
  editorRef?: React.RefObject<ComposerState>;
  history?: readonly string[];
  onEmptyInterrupt?(): void;
  activeModelName: string | undefined;
  placeholder?: string;
  disabled?: boolean;
  onApprovalChoice?(approved: boolean): void;
  getFileSuggestions?(query: string, signal?: AbortSignal): Promise<string[]>;
  onSubmit(value: string): boolean | void | Promise<boolean | void>;
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

function FileReferenceMenu({ files, selectedIndex }: { files: readonly string[]; selectedIndex: number }) {
  const firstVisibleIndex = Math.max(0, Math.min(selectedIndex - 7, files.length - 8));
  return (
    <Box width="100%" flexDirection="column" backgroundColor="#111827" paddingX={1} overflow="hidden">
      {files.slice(firstVisibleIndex, firstVisibleIndex + 8).map((file, index) => {
        const selected = firstVisibleIndex + index === selectedIndex;
        return <Box key={file} height={1} overflow="hidden">
          <Text bold={selected} color={selected ? "#D4AF37" : "#D1D5DB"} wrap="truncate-end">
            {selected ? "› " : "  "}{file}
          </Text>
        </Box>;
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
  onApprovalChoice,
  onSubmit,
  history = [],
  onEmptyInterrupt,
  editorRef,
  historyNavigationRef,
  placeholder: placeholderOverride,
  getFileSuggestions,
}: PromptProps) {
  const localNavigation = useRef<{ index: number | undefined; draft: string }>({ index: undefined, draft: "" });
  const navigation = historyNavigationRef ?? localNavigation;
  const { columns } = useWindowSize();
  const localStateRef = useRef<ComposerState>(createComposerState());
  const stateRef = editorRef ?? localStateRef;
  const [state, setState] = useState(stateRef.current);
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0);
  const [dismissedSlashCommandValue, setDismissedSlashCommandValue] = useState<
    string | undefined
  >();
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [dismissedFileValue, setDismissedFileValue] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const lifetimeRef = useRef<symbol | undefined>(undefined);
  const submissionRef = useRef<symbol | undefined>(undefined);
  useLayoutEffect(() => {
    lifetimeRef.current = Symbol();
    return () => {
      lifetimeRef.current = undefined;
      submissionRef.current = undefined;
    };
  }, []);
  const placeholder = placeholderOverride ?? (activeModelName
    ? uiText('m7083c2087d57')
    : uiText('m03d5daf8e826'));
  const updateState = (operation: (current: ComposerState) => ComposerState) => {
    const current = stateRef.current;
    const next = operation(current);
    stateRef.current = next;
    setState(next);
    if (next.value !== current.value) {
      setSelectedSlashCommandIndex(0);
      setDismissedSlashCommandValue(undefined);
      setSelectedFileIndex(0);
      setDismissedFileValue(undefined);
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
  const activeFileQuery = useMemo(
    () => activeFileReferenceQuery(state.value, state.cursor),
    [state.cursor, state.value],
  );
  useEffect(() => {
    if (!getFileSuggestions || !activeFileQuery || slashCommandMenuVisible) {
      setFileSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void getFileSuggestions(activeFileQuery.query, controller.signal)
        .then((files) => {
          if (!controller.signal.aborted) setFileSuggestions(files);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFileSuggestions([]);
        });
    }, 100);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [activeFileQuery?.query, getFileSuggestions, slashCommandMenuVisible]);
  const effectiveFileIndex = Math.min(selectedFileIndex, Math.max(0, fileSuggestions.length - 1));
  const fileMenuVisible = Boolean(
    activeFileQuery &&
    fileSuggestions.length > 0 &&
    dismissedFileValue !== state.value &&
    !slashCommandMenuVisible
  );
  const selectedFile = fileMenuVisible ? fileSuggestions[effectiveFileIndex] : undefined;
  const attachmentLabels = useMemo(() => parseFileReferences(state.value), [state.value]);

  const completeFileReference = (file: string) => {
    if (!activeFileQuery) return;
    updateState((current) => {
      const items = Array.from(current.value);
      const replacement = Array.from(quotedFileReference(file));
      items.splice(activeFileQuery.start, current.cursor - activeFileQuery.start, ...replacement);
      return {
        ...current,
        value: items.join(""),
        cursor: activeFileQuery.start + replacement.length,
        preferredColumn: null,
      };
    });
    setFileSuggestions([]);
  };

  usePaste((text) => {
    if (submissionRef.current === undefined) updateState((current) => insertComposerText(current, text));
  }, { isActive: !disabled && !submitting });
  useInput(
    (input, key) => {
      if (key.eventType === "release" || submissionRef.current !== undefined) return;
      if (onApprovalChoice && !stateRef.current.value && !key.ctrl && !key.meta) {
        if (input.toLowerCase() === "y") { onApprovalChoice(true); return; }
        if (input.toLowerCase() === "n" || (key.return && !key.shift)) {
          onApprovalChoice(false);
          return;
        }
      }
      if (key.ctrl && input === "c") {
        if (stateRef.current.value) updateState(() => createComposerState());
        else onEmptyInterrupt?.();
        navigation.current.index = undefined;
        return;
      }

      if (key.return) {
        if (key.shift || key.meta || key.ctrl) {
          updateState((current) => insertComposerText(current, "\n"));
        } else if (selectedFile) {
          completeFileReference(selectedFile);
        } else {
          const submittedState = stateRef.current;
          const submittedValue = selectedSlashCommand ?? submittedState.value;
          const lifetime = lifetimeRef.current;
          const submission = Symbol();
          // Claim input before calling the host: React has not rendered the
          // disabled state yet, and the callback can synchronously reenter Ink.
          submissionRef.current = submission;
          const isCurrentSubmission = () =>
            lifetimeRef.current === lifetime && submissionRef.current === submission;
          const accept = () => {
            // The host may restore guidance or mount another prompt while a
            // submission waits. Only the original mounted draft can be cleared.
            if (!isCurrentSubmission() || stateRef.current !== submittedState) return;
            navigation.current = { index: undefined, draft: "" };
            updateState(() => createComposerState());
          };
          const finish = () => {
            if (!isCurrentSubmission()) return;
            submissionRef.current = undefined;
            setSubmitting(false);
          };
          try {
            const result = onSubmit(submittedValue);
            if (result && typeof (result as PromiseLike<unknown>).then === "function") {
              setSubmitting(true);
              void Promise.resolve(result)
                .then((accepted) => { if (accepted !== false) accept(); })
                .catch(() => undefined)
                .finally(finish);
            } else {
              if (result !== false) accept();
              finish();
            }
          } catch {
            // The draft remains available for correction when submission fails.
            finish();
          }
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
      if (fileMenuVisible && (key.upArrow || (key.ctrl && input === "p"))) {
        setSelectedFileIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (fileMenuVisible && (key.downArrow || (key.ctrl && input === "n"))) {
        setSelectedFileIndex((current) => Math.min(fileSuggestions.length - 1, current + 1));
        return;
      }
      if (fileMenuVisible && key.tab && selectedFile) {
        completeFileReference(selectedFile);
        return;
      }
      if (fileMenuVisible && key.escape) {
        setDismissedFileValue(state.value);
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
    { isActive: !disabled && !submitting },
  );

  const lines = useMemo(() => composerLines(state), [state]);
  const cursorLine = Math.max(
    0,
    lines.findIndex((line) => line.cursorColumn !== undefined),
  );
  const firstVisibleLine = Math.max(0, cursorLine - MAX_VISIBLE_LINES + 1);
  const visibleLines = lines.slice(firstVisibleLine, firstVisibleLine + MAX_VISIBLE_LINES);
  // Root padding, prompt padding, the marker and its gap consume five cells.
  const availableWidth = Math.max(1, columns - 5);

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
      ) : fileMenuVisible ? (
        <FileReferenceMenu files={fileSuggestions} selectedIndex={effectiveFileIndex} />
      ) : null}
      {attachmentLabels.length > 0 ? (
        <Text dimColor wrap="truncate-end">
          {uiText('m6418093875a0')}{attachmentLabels.slice(0, 8).map((reference) => `${reference.path}${reference.startLine ? `:${reference.startLine}-${reference.endLine}` : ""}`).join(" · ")}
        </Text>
      ) : null}
    </Box>
  );
}
