import {uiText} from '../../../localization/messages.js';
import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { TextInput } from "@inkjs/ui";
import type { TeamOptions, TeamSnapshot } from "../../../team/types.js";
import { RichOutput } from "../../rendering/rich-text.js";
import { truncateEnd } from "../../rendering/text-width.js";
import { commandScreenWidth, CommandSurface } from "./command-surface.js";

export function TeamSurface({ config, models, getSnapshot, busy, onConfigure, onAction, onBack }: {
  config: TeamOptions;
  models: Array<{ id: string; name: string }>;
  getSnapshot(): TeamSnapshot | undefined;
  busy: boolean;
  onConfigure(config: TeamOptions): Promise<void>;
  onAction(action: "cancel" | "cleanup" | "continue", id: string): Promise<void>;
  onBack(): void;
}) {
  const [snapshot, setSnapshot] = useState(getSnapshot);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<"tokenBudget" | "maxAttempts" | "timeoutMs" | undefined>();
  const [detail, setDetail] = useState(false);
  const [pending, setPending] = useState(false);
  const [offset, setOffset] = useState(0);
  const { rows, columns } = useWindowSize();
  const page = Math.max(1, rows - 14);
  const width = Math.max(1, commandScreenWidth(columns) - 4);
  useEffect(() => { const timer = setInterval(() => setSnapshot(getSnapshot()), 500); return () => clearInterval(timer); }, [getSnapshot]);
  const members = snapshot?.members ?? [];
  const labels = [config.enabled ? uiText('m05f2354b669e') : uiText('m80cf05cb011f'), uiText('mfd42a384be51', {p0: config.maxAgents ?? 3}), ...(["explorer", "worker", "reviewer"] as const).map((role) => `${role}: ${models.find((model) => model.id === config.models?.[role])?.name ?? uiText('m99f57238e8a6')}`), uiText('mfde2856e423a', {p0: config.tokenBudget ?? "unlimited"}), uiText('m81ec5ddea4d4', {p0: config.maxAttempts ?? 96}), uiText('m80c86c2b4dda', {p0: (config.timeoutMs ?? 1_800_000) / 60_000}), uiText('m609609bce155'), ...members.map((member) => `${member.task.role} · ${member.state} · ${member.task.goal.slice(0, 45)}`)];
  const act = async (run: () => Promise<void>) => { setPending(true); setError(""); try { await run(); setSnapshot(getSnapshot()); } catch (failure) { setError(failure instanceof Error ? failure.message : uiText('m4a0487b903a3')); } finally { setPending(false); } };
  const update = (next: TeamOptions) => void act(() => onConfigure(next));
  useInput((input, key) => {
    if (pending || editing) return;
    if (detail) { if (key.return) setDetail(false); if (key.pageDown || key.downArrow) setOffset((current) => current + (key.pageDown ? page : 1)); if (key.pageUp || key.upArrow) setOffset((current) => Math.max(0, current - (key.pageUp ? page : 1))); return; }
    if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
    if (key.downArrow) setSelected((value) => Math.min(labels.length - 1, value + 1));
    const member = members[selected - 9];
    if (member && input === "c") void act(() => onAction("cancel", member.agentId));
    if (member && input === "d" && !busy) void act(() => onAction("cleanup", member.agentId));
    if (!key.return) return;
    if (member) { setOffset(0); setDetail(true); return; }
    if (busy) { setError(uiText('m931ab124df48')); return; }
    if (selected === 0) update({ ...config, enabled: !config.enabled });
    else if (selected === 1) update({ ...config, maxAgents: (config.maxAgents ?? 3) % 3 + 1 });
    else if (selected >= 2 && selected <= 4) {
      const role = (["explorer", "worker", "reviewer"] as const)[selected - 2]!;
      const ids = [undefined, ...models.map((model) => model.id)];
      const id = ids[(ids.indexOf(config.models?.[role]) + 1) % ids.length];
      const routing = { ...config.models }; if (id) routing[role] = id; else delete routing[role];
      update({ ...config, models: routing });
    } else if (selected >= 5 && selected <= 7) setEditing((["tokenBudget", "maxAttempts", "timeoutMs"] as const)[selected - 5]);
    else if (selected === 8 && snapshot) { if (snapshot.state === "finished" || snapshot.state === "running") setError(uiText('m041ed10b2825')); else void act(() => onAction("continue", snapshot.teamId)); }
  });
  const member = members[selected - 9];
  const attempts = snapshot?.usage.attempts.filter((attempt) => attempt.agentId === member?.agentId) ?? [];
  const memberTokens = attempts.reduce((sum, attempt) => sum + (attempt.usage?.input_tokens ?? 0) + (attempt.usage?.output_tokens ?? 0), 0);
  const details = member ? uiText('m58c3fff826b0', {p0: member.agentId, p1: member.task.goal, p2: member.task.acceptance, p3: member.modelId, p4: memberTokens, p5: attempts.length ? attempts.some((attempt) => attempt.usage === null) ? "incomplete" : uiText('ma8494befa4c1') : "unavailable", p6: member.task.paths.join(", "), p7: member.changedPaths?.join(", ") || uiText('m3a0c7d3fe275'), p8: member.verification ?? uiText('m2087cb5f8b63'), p9: member.sessionId ?? uiText('m7a7400f46669'), p10: member.workspacePath ?? uiText('mdd19b857b9af'), p11: member.summary ?? member.error ?? uiText('ma0a6f53c8209')}) : "";
  const totalLines = details.split("\n").length;
  useEffect(() => setOffset((current) => Math.min(current, Math.max(0, totalLines - page))), [totalLines, page]);
  useEffect(() => setSelected((current) => Math.min(current, labels.length - 1)), [labels.length]);
  const finishEdit = (value: string) => {
    if (!editing) return;
    const field = editing;
    if (!value.trim() && field === "tokenBudget") { const next = { ...config }; delete next.tokenBudget; setEditing(undefined); update(next); return; }
    const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1) { setError(uiText('mf73fcbc1acea')); return; }
    setEditing(undefined); update({ ...config, [field]: parsed });
  };
  return <CommandSurface title={uiText('m191af9f4d83b')} onBack={() => { if (editing || detail) { setEditing(undefined); setDetail(false); } else onBack(); }}>
    <Text wrap="truncate-end">{snapshot ? `${snapshot.teamId} · ${snapshot.state}` : uiText('m68f03b81d3d4')}</Text>
    {snapshot ? <Text>{uiText('mfde9dd0f7189')}{snapshot.usage.inputTokens + snapshot.usage.outputTokens}{uiText('mdaaff17e8d12')}{snapshot.openRequests}{uiText('m6247b392a345')}{snapshot.usage.complete ? uiText('ma8494befa4c1') : "incomplete"}</Text> : null}
    {detail && member ? <Box flexDirection="column"><Text dimColor>{offset + 1}-{Math.min(totalLines, offset + page)} / {totalLines}{uiText('m071e96130496')}</Text><RichOutput text={details} range={{ start: offset, count: page }} /></Box> : editing ? <Box flexDirection="column"><Text>{uiText('m617ca6384592')}{editing === "tokenBudget" ? uiText('m8c76d62e0412') : editing}{editing === "timeoutMs" ? uiText('m9a406eb7f6e6') : ""}{editing === "tokenBudget" ? uiText('m99599d7e9108') : ""}</Text><TextInput onSubmit={finishEdit} /></Box> : labels.slice(Math.max(0, selected - 4), Math.max(0, selected - 4) + Math.max(1, Math.min(8, rows - 14))).map((label, index) => <Text key={index} {...(index + Math.max(0, selected - 4) === selected ? { color: "yellow" as const } : {})}>{index + Math.max(0, selected - 4) === selected ? "› " : "  "}{truncateEnd(label, width - 2)}</Text>)}
    {error ? <Text color="red">{error}</Text> : null}
    <Text dimColor wrap="truncate-end">{pending ? uiText('mdfe40efe921f') : uiText('m6ac9cf9eddc9')}</Text>
    <Text dimColor>{uiText('mf02c610e5e1b')}</Text>
  </CommandSurface>;
}
