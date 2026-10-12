import {uiText} from '../../../localization/messages.js';
import { Select } from "@inkjs/ui";
import { Box, Text } from "ink";
import React, { useState } from "react";
import type { LearnedMemoryPolicy, LearnedMemoryStatus, LearnedScope } from "../../../memory/learned-memory.js";
import { CommandSurface } from "./command-surface.js";

export function MemorySurface({
  status,
  policy,
  onBack,
  onToggle,
  onPolicyChange,
  onArchive,
  onClear,
}: {
  status: LearnedMemoryStatus;
  policy: LearnedMemoryPolicy;
  onBack(): void;
  onToggle(enabled: boolean): void;
  onPolicyChange(patch: Partial<LearnedMemoryPolicy>): void;
  onArchive(entry: LearnedMemoryStatus["recent"][number]): void;
  onClear(scope: LearnedScope): void;
}) {
  const [confirmScope, setConfirmScope] = useState<LearnedScope>();
  const toggleLabel = status.enabled ? uiText('m8d72cbf86551') : uiText('m70e34e008988');
  if (confirmScope) {
    const label = confirmScope === "project" ? uiText('m5b3cc031816d') : uiText('m048375e06262');
    return (
      <CommandSurface title={uiText('me8620fb15727')} onBack={onBack}>
        <Text color="yellow">{uiText('mbb81214fb2c8')}{label}{uiText('m7f5d26a5b27f')}</Text>
        <Select options={[
          { label: uiText('m19766ed6ccb2'), value: "cancel" },
          { label: uiText('m2d281c32586a', {p0: label}), value: "clear" },
        ]} onChange={(value) => {
          if (value === "clear") onClear(confirmScope);
          setConfirmScope(undefined);
        }} />
      </CommandSurface>
    );
  }

  return (
    <CommandSurface title={uiText('medeae9cc8394')} onBack={onBack}>
      <Box flexDirection="column">
        <Text>{uiText('mdfeff63e663f')}<Text color={status.enabled ? "green" : "yellow"}>{status.enabled ? "enabled" : "disabled"}</Text></Text>
        <Text>{uiText('mee076572baf1')}<Text color={policy.readExisting ? "green" : "yellow"}>{policy.readExisting ? "enabled" : "disabled"}</Text></Text>
        <Text>{uiText('mf4280ab62c06')}<Text color={policy.captureFuture ? "green" : "yellow"}>{policy.captureFuture ? "enabled" : "disabled"}</Text></Text>
        <Text>{uiText('me9ddf5699691')}{status.projectEntries}</Text>
        <Text>{uiText('m783bcdc85170')}{status.userEntries}</Text>
        <Text>{uiText('m6b8436b69db8')}{status.needsReview ?? "unknown"}</Text>
        <Text dimColor>{uiText('m7e649f6717fb')}</Text>
        {status.capture ? <Text>{uiText('m6d7ac707bce6')}<Text color={status.capture.state === "failed" ? "red" : status.capture.state === "succeeded" ? "green" : "yellow"}>{status.capture.state}</Text></Text> : null}
        {status.capture?.queued !== undefined ? <Text>{uiText('m4976bf0963de')}{status.capture.queued}</Text> : null}
        {status.capture?.usage === null ? <Text>{uiText('m46771f58fe24')}</Text> : status.capture?.usage ? <Text>{uiText('m8b9127cf77eb')}{status.capture.usage.total_tokens}{uiText('mda61a22badf8')}</Text> : null}
      </Box>
      {status.recent.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{uiText('m690dbe9dc099')}</Text>
          {status.recent.map((entry) => (
            <Text key={`${entry.createdAt}-${entry.scope}-${entry.lesson}`}>
              [{entry.scope}#{entry.id}] {entry.lesson}{entry.expiresAt ? uiText('mce50a28f87d8', {p0: entry.expiresAt.slice(0, 10)}) : ""}
            </Text>
          ))}
        </Box>
      ) : <Box marginTop={1}><Text dimColor>{uiText('me9c8b88a177d')}</Text></Box>}
      <Select options={[
        { label: toggleLabel, value: "toggle" },
        { label: uiText('m435aae06ca1f', {p0: policy.readExisting ? uiText('mb7e3e4aa4257') : uiText('m5342e09f2729')}), value: "read" },
        { label: uiText('m0234ba8aa0e6', {p0: policy.captureFuture ? uiText('mb7e3e4aa4257') : uiText('m5342e09f2729')}), value: "capture" },
        ...(status.recent.length > 0 ? [{ label: uiText('m8efc069322a3'), value: "archive" }] : []),
        { label: uiText('m9196561d8355'), value: "clear-project" },
        { label: uiText('m84e723ca797f'), value: "clear-user" },
        { label: uiText('mdea785dbd445'), value: "back" },
      ]} onChange={(value) => {
        if (value === "toggle") onToggle(!status.enabled);
        if (value === "read") onPolicyChange({ readExisting: !policy.readExisting });
        if (value === "capture") onPolicyChange({ captureFuture: !policy.captureFuture });
        if (value === "archive" && status.recent[0]) onArchive(status.recent[0]);
        if (value === "clear-project") setConfirmScope("project");
        if (value === "clear-user") setConfirmScope("user");
        if (value === "back") onBack();
      }} />
    </CommandSurface>
  );
}
