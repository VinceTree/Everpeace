import { ConfirmInput, MultiSelect, Spinner } from "@inkjs/ui";
import { Box, Text, useInput, usePaste, useWindowSize } from "ink";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  SessionSearchMatch,
  SessionSearchResult,
  SessionSummary,
} from "../../../storage/session-store.js";
import { truncateEnd } from "../../rendering/text-width.js";
import { CommandSurface, commandScreenWidth } from "../screens/command-surface.js";
import { translateLegacyUiText } from "../../rendering/legacy-translation.js";

type SessionPickerMode = "resume" | "delete" | "confirm" | "deleting";

export interface SessionPickerProps {
  initialResult: SessionSearchResult;
  initialQuery?: string;
  search(query: string, allWorkspaces: boolean, offset: number, signal?: AbortSignal): Promise<SessionSearchResult>;
  onSelect(session: SessionSummary): void;
  onDelete(sessionIds: string[]): Promise<void>;
  onCancel(): void;
}

function sessionLabel(match: SessionSearchMatch, maximumWidth: number, allWorkspaces: boolean): string {
  const timestamp = new Date(match.summary.updated_at).toLocaleString("en-US");
  const workspace = allWorkspaces ? ` · ${match.summary.workspace_path}` : "";
  return truncateEnd(`${translateLegacyUiText(match.summary.title)} — ${timestamp}${workspace}`, maximumWidth);
}

export function SessionPicker({
  initialResult,
  initialQuery = "",
  search,
  onSelect,
  onDelete,
  onCancel,
}: SessionPickerProps) {
  const { columns } = useWindowSize();
  const labelWidth = Math.max(1, commandScreenWidth(columns) - 6);
  const [mode, setMode] = useState<SessionPickerMode>("resume");
  const [query, setQuery] = useState(initialQuery);
  const [allWorkspaces, setAllWorkspaces] = useState(false);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState(initialResult);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string>();
  const operation = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const active = new AbortController();
    controller.current?.abort();
    controller.current = active;
    const id = ++operation.current;
    const timer = setTimeout(() => {
      setSearching(true);
      void search(query, allWorkspaces, offset, active.signal)
        .then((next) => {
          if (active.signal.aborted || id !== operation.current) return;
          setResult(next);
          setSelectedIndex(0);
          setSelectedIds([]);
          setError(undefined);
        })
        .catch((caught: unknown) => {
          if (active.signal.aborted || id !== operation.current) return;
          setError(caught instanceof Error ? caught.message : String(caught));
        })
        .finally(() => {
          if (id === operation.current) setSearching(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      active.abort();
    };
  }, [allWorkspaces, offset, query, search]);

  const matches = result.matches;
  const visibleStart = Math.max(0, Math.min(selectedIndex - 7, matches.length - 8));
  const visible = matches.slice(visibleStart, visibleStart + 8);
  const pages = Math.max(1, Math.ceil(result.total / 50));
  const page = Math.floor(offset / 50) + 1;
  const options = useMemo(() => matches.map((match) => ({
    label: sessionLabel(match, labelWidth, allWorkspaces),
    value: match.summary.id,
  })), [allWorkspaces, labelWidth, matches]);

  const appendQuery = (value: string) => {
    if (mode !== "resume") return;
    setQuery((current) => current + value.replace(/[\r\n]/gu, " "));
    setOffset(0);
  };
  usePaste(appendQuery, { isActive: mode === "resume" });
  useInput((input, key) => {
    if (mode !== "resume") return;
    if (key.upArrow) setSelectedIndex((current) => Math.max(0, current - 1));
    else if (key.downArrow) setSelectedIndex((current) => Math.min(matches.length - 1, current + 1));
    else if (key.pageUp && offset > 0) setOffset(Math.max(0, offset - 50));
    else if (key.pageDown && offset + 50 < result.total) setOffset(offset + 50);
    else if (key.tab || input === "\t" || (key.ctrl && input === "a") || key.leftArrow || key.rightArrow) {
      setAllWorkspaces((current) => !current);
      setOffset(0);
    } else if (key.return && matches[selectedIndex]) onSelect(matches[selectedIndex].summary);
    else if (key.return && matches.length === 0 && !allWorkspaces) {
      setAllWorkspaces(true);
      setOffset(0);
    }
    else if (key.backspace || key.delete) {
      setQuery((current) => Array.from(current).slice(0, -1).join(""));
      setOffset(0);
    } else if (key.ctrl && input === "u") {
      setQuery("");
      setOffset(0);
    } else if (key.ctrl && input === "d") {
      setMode("delete");
    } else if (!key.ctrl && !key.meta && input && !key.escape) appendQuery(input);
  });

  const back = () => {
    if (mode === "resume") onCancel();
    else if (mode === "confirm") setMode("delete");
    else if (mode !== "deleting") setMode("resume");
  };

  return <CommandSurface title={mode === "resume" ? "/resume · Resume session" : "/resume · Delete sessions"} onBack={back}>
    {result.skipped > 0 ? <Text color="yellow">Skipped {result.skipped} damaged session file{result.skipped === 1 ? "" : "s"}.</Text> : null}
    {error ? <Text color="red">{error}</Text> : null}
    {mode === "resume" ? <Box flexDirection="column">
      <Text>Search: <Text color="#D4AF37">{query || " "}</Text><Text inverse> </Text></Text>
      <Text dimColor>Scope: {allWorkspaces ? "All workspaces" : "This workspace"} · page {page}/{pages}{searching ? " · searching" : ""}</Text>
      {visible.length > 0 ? visible.map((match, index) => {
        const absolute = visibleStart + index;
        const selected = absolute === selectedIndex;
        return <Box key={match.summary.id} flexDirection="column">
          <Text bold={selected} {...(selected ? { color: "#D4AF37" } : {})} wrap="truncate-end">
            {selected ? "› " : "  "}{sessionLabel(match, labelWidth, allWorkspaces)}
          </Text>
          {selected && match.match ? <Text dimColor wrap="truncate-end">  {match.match.kind}: {match.match.snippet}</Text> : null}
          {selected && match.preview ? match.preview.map((item, previewIndex) => (
            <Text key={`${match.summary.id}:preview:${previewIndex}`} dimColor wrap="truncate-end">
              {previewIndex === 0 ? "  Preview · " : "            "}{item.kind}: {item.snippet}
            </Text>
          )) : null}
        </Box>;
      }) : <Text>{searching ? "Searching…" : query ? "No matching sessions" : allWorkspaces ? "No sessions are available to resume" : "No sessions are available to resume in this workspace · Enter searches all workspaces"}</Text>}
      <Text dimColor>Type to search · ↑↓ select · Enter resume · Tab/←→ scope · PgUp/PgDn page · Ctrl+U clear</Text>
      <Text dimColor>Delete sessions... (Ctrl+D) · Esc return</Text>
    </Box> : null}
    {mode === "delete" ? <>
      {options.length > 0 ? <MultiSelect options={options} visibleOptionCount={Math.min(8, options.length)} onSubmit={(ids) => {
        if (ids.length === 0) {
          setError("Select at least one session");
          return;
        }
        setSelectedIds(ids);
        setError(undefined);
        setMode("confirm");
      }} /> : <Text>No sessions on this result page.</Text>}
      <Text dimColor>↑↓ move · Space select · Enter continue · Esc results</Text>
    </> : null}
    {mode === "confirm" ? <Box flexDirection="column">
      <Text color="yellow">Permanently delete {selectedIds.length} session{selectedIds.length === 1 ? "" : "s"}? This cannot be undone.</Text>
      <ConfirmInput defaultChoice="cancel" onConfirm={() => {
        setMode("deleting");
        void onDelete(selectedIds)
          .then(() => search(query, allWorkspaces, offset))
          .then((next) => {
            setResult(next);
            setSelectedIds([]);
            setMode("resume");
          })
          .catch((caught: unknown) => {
            setError(caught instanceof Error ? caught.message : String(caught));
            setMode("delete");
          });
      }} onCancel={() => setMode("delete")} />
    </Box> : null}
    {mode === "deleting" ? <Spinner label="Deleting sessions" /> : null}
  </CommandSurface>;
}
