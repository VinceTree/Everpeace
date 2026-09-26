import { ConfirmInput, Select, TextInput } from "@inkjs/ui";
import { Text } from "ink";
import React, { useState } from "react";
import type { CommandRuleAction, PermissionPolicy } from "../../../permissions/policy.js";
import { CommandSurface } from "../screens/command-surface.js";

export function PermissionsPicker({ policy, workspace, onChange, onSaveProject, onBack }: {
  policy: PermissionPolicy;
  workspace: string;
  onChange(policy: PermissionPolicy): void;
  onSaveProject?(policy: PermissionPolicy): void;
  onBack(): void;
}) {
  const [confirmFull, setConfirmFull] = useState(false);
  const [addingRule, setAddingRule] = useState(false);
  const [ruleAction, setRuleAction] = useState<CommandRuleAction>("ask");
  const rules = policy.commandRules ?? [];
  if (addingRule) {
    return (
      <CommandSurface title="/permissions · Add command rule" onBack={() => setAddingRule(false)}>
        <Text>User policy is persisted; project policy can only restrict model Bash.</Text>
        <Text>Action: {ruleAction}</Text>
        <Select
          options={[{ label: "Ask", value: "ask" }, { label: "Allow", value: "allow" }, { label: "Deny", value: "deny" }]}
          onChange={(value) => setRuleAction(value as CommandRuleAction)}
        />
        <TextInput placeholder="Command prefix, e.g. pnpm test" onSubmit={(value) => {
          const prefix = value.trim();
          if (!prefix) return;
          onChange({ ...policy, commandRules: [...rules, { prefix, action: ruleAction }] });
          setAddingRule(false);
        }} />
      </CommandSurface>
    );
  }
  return (
    <CommandSurface title="/permissions" onBack={confirmFull ? () => setConfirmFull(false) : onBack}>
      <Text>Mode: {policy.mode}</Text>
      <Text wrap="truncate-middle">File tools: {workspace}</Text>
      <Text>Model shell sandbox: Codex native OS enforcement</Text>
      <Text>Web tools: {policy.web ? "enabled" : "disabled"}</Text>
      <Text>Command rules: {rules.length === 0 ? "none" : rules.map((rule) => `${rule.action} ${rule.prefix}`).join(" · ")}</Text>
      {confirmFull ? <>
        <Text color="yellow">Full access selects the Codex danger-full-access profile and skips tool approvals. Model commands can modify files outside the workspace and access the network.</Text>
        <ConfirmInput defaultChoice="cancel" onCancel={() => setConfirmFull(false)} onConfirm={() => onChange({ ...policy, mode: "full-access" })} />
      </> : <Select
        defaultValue={policy.mode}
        options={[
          { label: "Read only: sandboxed reads; approve Bash, web, MCP", value: "read-only" },
          { label: "Ask for approval: review every Bash, web, MCP call", value: "ask" },
          { label: "Workspace write: sandboxed edits; web allowed; MCP asks", value: "workspace-write" },
          { label: "Full access: no tool approvals", value: "full-access" },
          { label: policy.web ? "Disable web tools" : "Enable web tools", value: "web" },
          { label: "Add command prefix rule", value: "add-rule" },
          { label: "Save current policy for this project", value: "save-project" },
          ...(rules.length > 0 ? [{ label: "Clear command prefix rules", value: "clear-rules" }] : []),
        ]}
        onChange={(value) => {
          if (value === "full-access") setConfirmFull(true);
          else if (value === "web") onChange({ ...policy, web: !policy.web });
          else if (value === "add-rule") setAddingRule(true);
          else if (value === "save-project") onSaveProject?.(policy);
          else if (value === "clear-rules") onChange({ ...policy, commandRules: [] });
          else if (value === "ask" || value === "read-only" || value === "workspace-write") onChange({ ...policy, mode: value });
        }}
      />}
    </CommandSurface>
  );
}
