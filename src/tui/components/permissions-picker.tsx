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
      <Text>OS sandbox: unavailable; Bash uses the host account</Text>
      <Text>Web tools: {policy.web ? "enabled" : "disabled"}</Text>
      {confirmFull ? <>
        <Text color="yellow">Full access runs model commands with your OS account permissions, without approval. Commands can modify files outside the workspace and access the network.</Text>
        <ConfirmInput defaultChoice="cancel" onCancel={() => setConfirmFull(false)} onConfirm={() => onChange({ ...policy, mode: "full-access" })} />
      </> : <Select
        defaultValue={policy.mode}
        options={[
          { label: "Read only: workspace reads; approve Bash and web", value: "read-only" },
          { label: "Ask for approval: review every Bash and web call", value: "ask" },
          { label: "Workspace write: edit here without prompts; approve web", value: "workspace-write" },
          { label: "Full access: no tool approvals", value: "full-access" },
          { label: policy.web ? "Disable web tools" : "Enable web tools", value: "web" },
        ]}
        onChange={(value) => {
          if (value === "full-access") setConfirmFull(true);
          else if (value === "web") onChange({ ...policy, web: !policy.web });
          else if (value === "ask" || value === "read-only" || value === "workspace-write") onChange({ ...policy, mode: value });
        }}
      />}
    </CommandSurface>
  );
}
