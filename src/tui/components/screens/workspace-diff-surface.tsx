import {uiText} from '../../../localization/messages.js';
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
    ? uiText('m0fa017a40623', {p0: workflow.result, p1: new Date(workflow.updated_at).toLocaleString("en-US")})
    : uiText('m4f4554ccb95c');
  return <CommandSurface title={uiText('m1f88c1f77c26')} onBack={() => {
    if (detail) {
      controller.current?.abort();
      setDetail(undefined);
      setError("");
      setOffset(0);
    } else onBack();
  }}>
    <Text dimColor>{lastResult}</Text>
    {error ? <Text color="red">{error}</Text> : null}
    {loading ? <Spinner label={detail ? uiText('m6a9c07f25dc1') : uiText('m8345f7b39929')} /> : null}
    {detail ? <Box flexDirection="column">
      <Text bold>{detail.entry.kind.toUpperCase()} · {detail.entry.path}</Text>
      <Text dimColor>{lines.length === 0 ? uiText('mcfc5bfc234ca') : `${offset + 1}-${Math.min(lines.length, offset + page)} / ${lines.length}`}{detail.truncated ? uiText('m533b274522ec') : ""}</Text>
      {detail.warning ? <Text color="yellow">{detail.warning}</Text> : null}
      <RichOutput text={detail.text} range={{ start: offset, count: page }} />
      <Text dimColor>{uiText('m7f413317800b')}</Text>
    </Box> : index.entries.length > 0 ? <>
      <Text dimColor>{index.entries.length}{uiText('m26af5089068b')}{new Date(index.capturedAt).toLocaleTimeString("en-US")}</Text>
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
      <Text dimColor>{uiText('m2edb2d3bc22f')}</Text>
    </> : <>
      <Text>{uiText('m48d79755f28b')}</Text>
      <Text dimColor>{uiText('m67dd15aa52dc')}</Text>
    </>}
  </CommandSurface>;
}
