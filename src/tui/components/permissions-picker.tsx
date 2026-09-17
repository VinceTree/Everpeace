import { ConfirmInput, Select } from "@inkjs/ui";
import { Text } from "ink";
import React, { useState } from "react";
import type { PermissionPolicy } from "../../permissions/policy.js";
import { CommandSurface } from "./command-surface.js";

export function PermissionsPicker({ policy, workspace, onChange, onBack }: {
  policy: PermissionPolicy;
  workspace: string;
  onChange(policy: PermissionPolicy): void;
  onBack(): void;
}) {
  const [confirmFull, setConfirmFull] = useState(false);
  return (
    <CommandSurface title="/permissions" onBack={confirmFull ? () => setConfirmFull(false) : onBack}>
      <Text>Mode: {policy.mode}</Text>
      <Text wrap="truncate-middle">File tools: {workspace}</Text>
      <Text>OS sandbox: unavailable</Text>
      <Text>Web tools: {policy.web ? "enabled" : "disabled"}</Text>
      {confirmFull ? <>
        <Text color="yellow">Full access runs model commands with your OS account permissions, without approval. Commands can modify files outside the workspace and access the network.</Text>
        <ConfirmInput defaultChoice="cancel" onCancel={() => setConfirmFull(false)} onConfirm={() => onChange({ ...policy, mode: "full-access" })} />
      </> : <Select
        options={[
          { label: "Read only: workspace file tools; no model Bash", value: "read-only" },
          { label: "Ask for approval: confirm every Bash command", value: "ask" },
          { label: "Full access: no Bash approvals", value: "full-access" },
          { label: policy.web ? "Disable web tools" : "Enable web tools", value: "web" },
        ]}
        onChange={(value) => {
          if (value === "full-access") setConfirmFull(true);
          else if (value === "web") onChange({ ...policy, web: !policy.web });
          else if (value === "ask" || value === "read-only") onChange({ ...policy, mode: value });
        }}
      />}
    </CommandSurface>
  );
}
