import { Select, Spinner } from "@inkjs/ui";
import { Box, Text, useInput, useWindowSize } from "ink";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { WorkflowState } from "../../../workflow/types.js";
import type {
  WorkspaceChangeDetail,
  WorkspaceChangeEntry,
  WorkspaceChangeIndex,
} from "../../../tools/workspace-review.js";
import { RichOutput } from "../../rendering/rich-text.js";
import { truncateEnd } from "../../rendering/text-width.js";
import { CommandSurface, commandScreenWidth } from "./command-surface.js";

export function WorkspaceDiffSurface({
  initialIndex,
  workflow,
  readDetail,
  refresh,
  onBack,
}: {
  initialIndex: WorkspaceChangeIndex;
  workflow?: WorkflowState;
  readDetail(entry: WorkspaceChangeEntry, signal?: AbortSignal): Promise<WorkspaceChangeDetail>;
  refresh(signal?: AbortSignal): Promise<WorkspaceChangeIndex>;
  onBack(): void;
}) {
  const [index, setIndex] = useState(initialIndex);
  const [detail, setDetail] = useState<WorkspaceChangeDetail>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  const operation = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const { rows, columns } = useWindowSize();
  const page = Math.max(1, rows - 12);
  const lines = useMemo(() => detail?.text.split("\n") ?? [], [detail]);
  const maximumOffset = Math.max(0, lines.length - page);
  const reviewWidth = Math.max(1, commandScreenWidth(columns) - 6);

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => setOffset((current) => Math.min(current, maximumOffset)), [maximumOffset]);

  const load = (entry: WorkspaceChangeEntry) => {
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    const id = ++operation.current;
    setLoading(true);
    setError("");
    void readDetail(entry, active.signal)
      .then((value) => {
        if (operation.current !== id || active.signal.aborted) return;
        setDetail(value);
        setOffset(0);
      })
      .catch((caught: unknown) => {
        if (operation.current !== id || active.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (operation.current === id) setLoading(false);
      });
  };

  const reload = () => {
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    const id = ++operation.current;
    setLoading(true);
    setError("");
    void refresh(active.signal)
      .then((value) => {
        if (operation.current !== id || active.signal.aborted) return;
        setIndex(value);
        setDetail(undefined);
      })
      .catch((caught: unknown) => {
        if (operation.current !== id || active.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (operation.current === id) setLoading(false);
      });
  };

  useInput((input, key) => {
    if (!detail) {
      if (input.toLowerCase() === "r") reload();
      return;
    }
    if (key.upArrow) setOffset((value) => Math.max(0, value - 1));
    if (key.downArrow) setOffset((value) => Math.min(maximumOffset, value + 1));
    if (key.pageUp) setOffset((value) => Math.max(0, value - page));
    if (key.pageDown) setOffset((value) => Math.min(maximumOffset, value + page));
    if (key.home) setOffset(0);
    if (key.end) setOffset(maximumOffset);
    if (input.toLowerCase() === "r") load(detail.entry);
  });

  const lastResult = workflow?.result
    ? `Last task result: ${workflow.result} · ${new Date(workflow.updated_at).toLocaleString("en-US")}`
    : "Last task result: unavailable";
  return <CommandSurface title="/diff · Workspace changes" onBack={() => {
    if (detail) {
      controller.current?.abort();
      setDetail(undefined);
      setError("");
      setOffset(0);
    } else onBack();
  }}>
    <Text dimColor>{lastResult}</Text>
    {error ? <Text color="red">{error}</Text> : null}
    {loading ? <Spinner label={detail ? "Refreshing change detail" : "Reading workspace changes"} /> : null}
    {detail ? <Box flexDirection="column">
      <Text bold>{detail.entry.kind.toUpperCase()} · {detail.entry.path}</Text>
      <Text dimColor>{lines.length === 0 ? "0 lines" : `${offset + 1}-${Math.min(lines.length, offset + page)} / ${lines.length}`}{detail.truncated ? " · truncated" : ""}</Text>
      {detail.warning ? <Text color="yellow">{detail.warning}</Text> : null}
      <RichOutput text={detail.text} range={{ start: offset, count: page }} />
      <Text dimColor>↑↓ scroll · PgUp/PgDn page · Home/End · R refresh · Esc file list</Text>
    </Box> : index.entries.length > 0 ? <>
      <Text dimColor>{index.entries.length} entries · captured {new Date(index.capturedAt).toLocaleTimeString("en-US")}</Text>
      <Select
        visibleOptionCount={Math.min(8, index.entries.length)}
        options={index.entries.map((entry) => ({
          value: entry.id,
          label: truncateEnd(`${entry.kind.padEnd(9)} ${entry.status} ${entry.oldPath ? `${entry.oldPath} → ` : ""}${entry.path}`, reviewWidth),
        }))}
        onChange={(id) => {
          const entry = index.entries.find((candidate) => candidate.id === id);
          if (entry) load(entry);
        }}
      />
      <Text dimColor>↑↓ select · Enter inspect · R refresh · Esc return</Text>
    </> : <>
      <Text>No staged, unstaged, or untracked changes.</Text>
      <Text dimColor>R refresh · Esc return</Text>
    </>}
  </CommandSurface>;
}
