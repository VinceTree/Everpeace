import {uiText,translateHostText} from '../../../localization/messages.js';
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
  const title=match.summary.title_pending&&(match.summary.title==='New Session'||match.summary.title==='新 Session')
    ?translateHostText(translateLegacyUiText(match.summary.title)):match.summary.title;
  return truncateEnd(`${title} — ${timestamp}${workspace}`, maximumWidth);
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

  return <CommandSurface title={mode === "resume" ? uiText('mfe2ee5028847') : uiText('m4dd049c3bd20')} onBack={back}>
    {result.skipped > 0 ? <Text color="yellow">{uiText('mf10de79d9f19')}{result.skipped}{uiText('mb1e382b71f56')}{result.skipped === 1 ? "" : "s"}.</Text> : null}
    {error ? <Text color="red">{error}</Text> : null}
    {mode === "resume" ? <Box flexDirection="column">
      <Text>{uiText('m3363e5f143b7')}<Text color="#D4AF37">{query || " "}</Text><Text inverse> </Text></Text>
      <Text dimColor>{uiText('mb8417b265b19')}{allWorkspaces ? uiText('m415c8e38f8c6') : uiText('m3dd128ad70f4')}{uiText('mcace86a57daa')}{page}/{pages}{searching ? uiText('mbc81d72afe7d') : ""}</Text>
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
              {previewIndex === 0 ? uiText('mfec71f206db7') : "            "}{item.kind}: {item.snippet}
            </Text>
          )) : null}
        </Box>;
      }) : <Text>{searching ? uiText('mc31723ab3302') : query ? uiText('m2732406e3be5') : allWorkspaces ? uiText('m7dd89577d048') : uiText('m9c55d17589b4')}</Text>}
      <Text dimColor>{uiText('m60646d998475')}</Text>
      <Text dimColor>{uiText('m7ae58d302972')}</Text>
    </Box> : null}
    {mode === "delete" ? <>
      {options.length > 0 ? <MultiSelect options={options} visibleOptionCount={Math.min(8, options.length)} onSubmit={(ids) => {
        if (ids.length === 0) {
          setError(uiText('mc24c96870978'));
          return;
        }
        setSelectedIds(ids);
        setError(undefined);
        setMode("confirm");
      }} /> : <Text>{uiText('mda0336f3f412')}</Text>}
      <Text dimColor>{uiText('m5baa76d64374')}</Text>
    </> : null}
    {mode === "confirm" ? <Box flexDirection="column">
      <Text color="yellow">{uiText('m194d867366dc')}{selectedIds.length}{uiText('me916532afff9')}{selectedIds.length === 1 ? "" : "s"}{uiText('m7f5d26a5b27f')}</Text>
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
    {mode === "deleting" ? <Spinner label={uiText('mc916160b6431')} /> : null}
  </CommandSurface>;
}
