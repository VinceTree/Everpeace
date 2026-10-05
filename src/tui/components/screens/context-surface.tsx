import { Box, Text, useInput, useWindowSize } from "ink";
import React, { useEffect, useMemo, useState } from "react";
import type { ContextInspectionSnapshot } from "../../../agent/context-inspection.js";
import { RichOutput } from "../../rendering/rich-text.js";
import { CommandSurface } from "./command-surface.js";

export function formatContextInspection(snapshot: ContextInspectionSnapshot): string {
  const counts = Object.entries(snapshot.itemCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `- ${kind}: ${count}`);
  return [
    `Model: ${snapshot.model}`,
    `Provider: ${snapshot.provider}`,
    `Runtime agent: ${snapshot.runtimeIdentity.agent}`,
    `Protocol: ${snapshot.runtimeIdentity.protocol}`,
    `Workspace (cwd): ${snapshot.runtimeIdentity.workspacePath}`,
    `Submitted: ${snapshot.submittedAt}`,
    `Context revision: ${snapshot.contextRevision}`,
    `Request fingerprint: ${snapshot.requestFingerprint.slice(0, 16)}…`,
    `Estimated input: ${snapshot.estimatedInputTokens.toLocaleString("en-US")} tokens (${snapshot.estimateSource.replace(/_/gu, " ")})`,
    `Output reserve: ${snapshot.outputReserveTokens.toLocaleString("en-US")} tokens`,
    `Approximate component sizes: stable instructions ${snapshot.componentBytes.stableInstructions.toLocaleString("en-US")} bytes; dynamic instructions ${snapshot.componentBytes.dynamicInstructions.toLocaleString("en-US")} bytes (non-additive)`,
    "",
    "Conversation items",
    ...(counts.length ? counts : ["- none"]),
    ...Object.entries(snapshot.opaqueItemBytes).map(([kind, bytes]) => `- ${kind} opaque size: ${bytes.toLocaleString("en-US")} bytes`),
    "",
    "Project rules",
    ...(snapshot.projectRules.length
      ? snapshot.projectRules.map((rule) => `- ${rule.path} · scope ${rule.scope} · ${rule.revision.slice(0, 12)}…`)
      : ["- none"]),
    ...snapshot.projectRuleDiagnostics.map((diagnostic) => `- warning: ${diagnostic.path} · ${diagnostic.reason}`),
    "",
    `Skills advertised: ${snapshot.skills.advertised.join(", ") || "none"}`,
    `Skills explicitly included: ${snapshot.skills.explicitlyIncluded.join(", ") || "none"}`,
    `Memory revision: ${snapshot.memory.revision ?? "none"}`,
    `Memory entries: ${snapshot.memory.entryIds.join(", ") || "none"}`,
    `MCP servers: ${snapshot.mcp.servers.join(", ") || "none"}`,
    `MCP tools: ${snapshot.mcp.tools.join(", ") || "none"}`,
    `Advertised tools (${snapshot.advertisedTools.length}): ${snapshot.advertisedTools.join(", ") || "none"}`,
    "",
    "Attached file excerpts",
    ...(snapshot.attachments.length
      ? snapshot.attachments.map((attachment) => `- ${attachment.path}:${attachment.startLine}-${attachment.endLine} / ${attachment.totalLines}${attachment.truncated ? " · excerpt" : ""}`)
      : ["- none"]),
    "",
    "Redacted previews",
    ...(snapshot.previews.length
      ? snapshot.previews.flatMap((preview) => [`[${preview.kind}] ${preview.label}`, preview.text || "(empty)", ""])
      : ["No previewable sources were included."]),
  ].join("\n").trimEnd();
}

export function ContextSurface({
  getSnapshot,
  onBack,
}: {
  getSnapshot?(): ContextInspectionSnapshot | undefined;
  onBack(): void;
}) {
  const [snapshot, setSnapshot] = useState(() => getSnapshot?.());
  const [offset, setOffset] = useState(0);
  const { rows } = useWindowSize();
  const page = Math.max(1, rows - 9);
  const text = useMemo(() => snapshot
    ? formatContextInspection(snapshot)
    : getSnapshot
      ? "No coding request has been submitted by the active agent in this process yet. Resumed Session history is not reconstructed as an exact request."
      : "Context inspection is unavailable for the active agent integration.", [getSnapshot, snapshot]);
  const lines = text.split("\n");
  const maximumOffset = Math.max(0, lines.length - page);
  useEffect(() => setOffset((current) => Math.min(current, maximumOffset)), [maximumOffset]);
  useInput((input, key) => {
    if (key.upArrow) setOffset((value) => Math.max(0, value - 1));
    if (key.downArrow) setOffset((value) => Math.min(maximumOffset, value + 1));
    if (key.pageUp) setOffset((value) => Math.max(0, value - page));
    if (key.pageDown) setOffset((value) => Math.min(maximumOffset, value + page));
    if (key.home) setOffset(0);
    if (key.end) setOffset(maximumOffset);
    if (input.toLowerCase() === "r" && getSnapshot) {
      setSnapshot(getSnapshot());
      setOffset(0);
    }
  });
  return <CommandSurface title="/context · Last submitted coding request" onBack={onBack}>
    <Box flexDirection="column">
      <Text dimColor>{lines.length === 0 ? "0 lines" : `${offset + 1}-${Math.min(lines.length, offset + page)} / ${lines.length}`}</Text>
      <RichOutput text={text} range={{ start: offset, count: page }} />
      <Text dimColor>↑↓ scroll · PgUp/PgDn page · Home/End · R refresh · Esc return</Text>
    </Box>
  </CommandSurface>;
}
