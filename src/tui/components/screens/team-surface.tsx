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
  const labels = [config.enabled ? "Collaboration: on" : "Collaboration: off", `Agents: ${config.maxAgents ?? 3}`, ...(["explorer", "worker", "reviewer"] as const).map((role) => `${role}: ${models.find((model) => model.id === config.models?.[role])?.name ?? "inherit root"}`), `Request token budget: ${config.tokenBudget ?? "unlimited"} (not a spending cap)`, `Request attempts: ${config.maxAttempts ?? 96}`, `Deadline: ${(config.timeoutMs ?? 1_800_000) / 60_000} min`, "Continue interrupted team", ...members.map((member) => `${member.task.role} · ${member.state} · ${member.task.goal.slice(0, 45)}`)];
  const act = async (run: () => Promise<void>) => { setPending(true); setError(""); try { await run(); setSnapshot(getSnapshot()); } catch (failure) { setError(failure instanceof Error ? failure.message : "Team operation failed"); } finally { setPending(false); } };
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
    if (busy) { setError("Configuration changes are available when the task is idle."); return; }
    if (selected === 0) update({ ...config, enabled: !config.enabled });
    else if (selected === 1) update({ ...config, maxAgents: (config.maxAgents ?? 3) % 3 + 1 });
    else if (selected >= 2 && selected <= 4) {
      const role = (["explorer", "worker", "reviewer"] as const)[selected - 2]!;
      const ids = [undefined, ...models.map((model) => model.id)];
      const id = ids[(ids.indexOf(config.models?.[role]) + 1) % ids.length];
      const routing = { ...config.models }; if (id) routing[role] = id; else delete routing[role];
      update({ ...config, models: routing });
    } else if (selected >= 5 && selected <= 7) setEditing((["tokenBudget", "maxAttempts", "timeoutMs"] as const)[selected - 5]);
    else if (selected === 8 && snapshot) { if (snapshot.state === "finished" || snapshot.state === "running") setError("Only stopped or interrupted teams can be continued."); else void act(() => onAction("continue", snapshot.teamId)); }
  });
  const member = members[selected - 9];
  const attempts = snapshot?.usage.attempts.filter((attempt) => attempt.agentId === member?.agentId) ?? [];
  const memberTokens = attempts.reduce((sum, attempt) => sum + (attempt.usage?.input_tokens ?? 0) + (attempt.usage?.output_tokens ?? 0), 0);
  const details = member ? `${member.agentId}\n${member.task.goal}\nAcceptance: ${member.task.acceptance}\nModel: ${member.modelId}\nKnown consumption: ${memberTokens} tokens · Metering: ${attempts.length ? attempts.some((attempt) => attempt.usage === null) ? "incomplete" : "complete so far" : "unavailable"}\nIn-flight member requests: unavailable\nScopes: ${member.task.paths.join(", ")}\nFiles: ${member.changedPaths?.join(", ") || "none reported"}\nChecks: ${member.verification ?? "not reported"}\nSession: ${member.sessionId ?? "not started"}\nWorkspace: ${member.workspacePath ?? "none retained"}\n${member.summary ?? member.error ?? "Waiting for report"}` : "";
  const totalLines = details.split("\n").length;
  useEffect(() => setOffset((current) => Math.min(current, Math.max(0, totalLines - page))), [totalLines, page]);
  useEffect(() => setSelected((current) => Math.min(current, labels.length - 1)), [labels.length]);
  const finishEdit = (value: string) => {
    if (!editing) return;
    const field = editing;
    if (!value.trim() && field === "tokenBudget") { const next = { ...config }; delete next.tokenBudget; setEditing(undefined); update(next); return; }
    const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1) { setError("Enter a positive integer."); return; }
    setEditing(undefined); update({ ...config, [field]: parsed });
  };
  return <CommandSurface title="/team · Collaboration" onBack={() => { if (editing || detail) { setEditing(undefined); setDetail(false); } else onBack(); }}>
    <Text wrap="truncate-end">{snapshot ? `${snapshot.teamId} · ${snapshot.state}` : "No team has run in this Agent."}</Text>
    {snapshot ? <Text>Known consumption: {snapshot.usage.inputTokens + snapshot.usage.outputTokens} tokens · In-flight requests: {snapshot.openRequests} · Metering: {snapshot.usage.complete ? "complete so far" : "incomplete"}</Text> : null}
    {detail && member ? <Box flexDirection="column"><Text dimColor>{offset + 1}-{Math.min(totalLines, offset + page)} / {totalLines} · PgUp/PgDn scroll</Text><RichOutput text={details} range={{ start: offset, count: page }} /></Box> : editing ? <Box flexDirection="column"><Text>Set {editing === "tokenBudget" ? "Request token budget" : editing}{editing === "timeoutMs" ? " in milliseconds" : ""}{editing === "tokenBudget" ? " (blank for unlimited)" : ""}</Text><TextInput onSubmit={finishEdit} /></Box> : labels.slice(Math.max(0, selected - 4), Math.max(0, selected - 4) + Math.max(1, Math.min(8, rows - 14))).map((label, index) => <Text key={index} {...(index + Math.max(0, selected - 4) === selected ? { color: "yellow" as const } : {})}>{index + Math.max(0, selected - 4) === selected ? "› " : "  "}{truncateEnd(label, width - 2)}</Text>)}
    {error ? <Text color="red">{error}</Text> : null}
    <Text dimColor wrap="truncate-end">{pending ? "Updating…" : "↑↓ select · Enter details/configure · c cancel · d cleanup"}</Text>
    <Text dimColor>Member reports are evidence; root verification determines completion.</Text>
  </CommandSurface>;
}
