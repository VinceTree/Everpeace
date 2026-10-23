import {currentLanguage} from '../../../localization/language.js';
import {uiText} from '../../../localization/messages.js';
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
    uiText('ma2de6a074eea', {p0: snapshot.model}),
    uiText('m9864040d1a84', {p0: snapshot.provider}),
    uiText('mb499fdbc8b58', {p0: snapshot.runtimeIdentity.agent}),
    uiText('m6973763a8a88', {p0: snapshot.runtimeIdentity.protocol}),
    uiText('m20c6f53244e8', {p0: snapshot.runtimeIdentity.source}),
    uiText('m295e6807dafc', {p0: snapshot.runtimeIdentity.workspacePath}),
    uiText('m6c305812750e', {p0: snapshot.submittedAt}),
    uiText('m5682cd46ed94', {p0: snapshot.contextRevision}),
    uiText('medd68a55dde1', {p0: snapshot.requestFingerprint.slice(0, 16)}),
    uiText('m981fc6f18e93', {p0: snapshot.estimatedInputTokens.toLocaleString("en-US"), p1: snapshot.estimateSource.replace(/_/gu, " ")}),
    uiText('mcac046538868', {p0: snapshot.outputReserveTokens.toLocaleString("en-US")}),
    uiText('mfcae7ec687fb', {p0: snapshot.componentBytes.stableInstructions.toLocaleString("en-US"), p1: snapshot.componentBytes.dynamicInstructions.toLocaleString("en-US")}),
    "",
    uiText('m852070ddc6d7'),
    ...(counts.length ? counts : [uiText('md789759bdc2f')]),
    ...Object.entries(snapshot.opaqueItemBytes).map(([kind, bytes]) => uiText('mf89bb08fe61b', {p0: kind, p1: bytes.toLocaleString("en-US")})),
    "",
    uiText('m89c6c79f6a99'),
    ...(snapshot.projectRules.length
      ? snapshot.projectRules.map((rule) => uiText('m84c3eaaad62e', {p0: rule.path, p1: rule.scope, p2: rule.revision.slice(0, 12)}))
      : [uiText('md789759bdc2f')]),
    ...snapshot.projectRuleDiagnostics.map((diagnostic) => uiText('meb453a817374', {p0: diagnostic.path, p1: diagnostic.reason})),
    "",
    uiText('m33d52adddcad', {p0: snapshot.skills.advertised.join(", ") || "none"}),
    uiText('mdf2c7e9d01fc', {p0: snapshot.skills.explicitlyIncluded.join(", ") || "none"}),
    uiText('mc1bd8a60b0cb', {p0: snapshot.memory.revision ?? "none"}),
    uiText('m9c1833289560', {p0: snapshot.memory.entryIds.join(", ") || "none"}),
    uiText('mc8a1e601c9e2', {p0: snapshot.mcp.servers.join(", ") || "none"}),
    uiText('m6ca6a4ec098f', {p0: snapshot.mcp.tools.join(", ") || "none"}),
    uiText('me4d0af447ab3', {p0: snapshot.advertisedTools.length, p1: snapshot.advertisedTools.join(", ") || "none"}),
    "",
    uiText('m2bb2094515e9'),
    ...(snapshot.attachments.length
      ? snapshot.attachments.map((attachment) => `- ${attachment.path}:${attachment.startLine}-${attachment.endLine} / ${attachment.totalLines}${attachment.truncated ? uiText('mf0f35ac23ef5') : ""}`)
      : [uiText('md789759bdc2f')]),
    "",
    uiText('m6512139e20a7'),
    ...(snapshot.previews.length
      ? snapshot.previews.flatMap((preview) => [`[${preview.kind}] ${preview.label}`, preview.text || uiText('md29a0939bcb5'), ""])
      : [uiText('ma4b88877200f')]),
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
      ? uiText('m4ef3e2975ad1')
      : uiText('m6d2008068cc0'), [getSnapshot, snapshot,currentLanguage()]);
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
  return <CommandSurface title={uiText('m3484e5bf7b89')} onBack={onBack}>
    <Box flexDirection="column">
      <Text dimColor>{lines.length === 0 ? uiText('mcfc5bfc234ca') : `${offset + 1}-${Math.min(lines.length, offset + page)} / ${lines.length}`}</Text>
      <RichOutput text={text} range={{ start: offset, count: page }} />
      <Text dimColor>{uiText('m1ad4e69a7031')}</Text>
    </Box>
  </CommandSurface>;
}
