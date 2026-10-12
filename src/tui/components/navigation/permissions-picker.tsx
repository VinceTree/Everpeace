import {uiText} from '../../../localization/messages.js';
import { ConfirmInput, Select, TextInput } from "@inkjs/ui";
import { Text } from "ink";
import React, { useState } from "react";
import type { CommandRuleAction, PermissionPolicy } from "../../../permissions/policy.js";
import { CommandSurface } from "../screens/command-surface.js";

function setShellNetwork(policy: PermissionPolicy, deny: boolean): PermissionPolicy {
  const { shellNetwork: _shellNetwork, ...rest } = policy;
  return deny ? { ...rest, shellNetwork: "deny" } : rest;
}

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
      <CommandSurface title={uiText('ma56fa67ecd08')} onBack={() => setAddingRule(false)}>
        <Text>{uiText('m901bb342ca02')}</Text>
        <Text>{uiText('m1a479a3479a3')}{ruleAction}</Text>
        <Select
          options={[{ label: uiText('mb8c209cdead6'), value: "ask" }, { label: uiText('me213c161d5ce'), value: "allow" }, { label: uiText('m05a2d7332eb9'), value: "deny" }]}
          onChange={(value) => setRuleAction(value as CommandRuleAction)}
        />
        <TextInput placeholder={uiText('m01a56e68355a')} onSubmit={(value) => {
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
      <Text>{uiText('m6d155e134de0')}{policy.mode}</Text>
      <Text wrap="truncate-middle">{uiText('m1096e6487ef2')}{workspace}</Text>
      <Text>{uiText('m258a6e042c80')}</Text>
      <Text>{uiText('m47fd8b1f73ed')}{policy.shellNetwork === "deny" ? uiText('m347509305643') : uiText('m7561d826ac40')}</Text>
      <Text>{uiText('m6938556113fc')}{policy.web ? "enabled" : "disabled"}</Text>
      <Text>{uiText('mc22d40aed41b')}{rules.length === 0 ? "none" : rules.map((rule) => `${rule.action} ${rule.prefix}`).join(" · ")}</Text>
      {confirmFull ? <>
        <Text color="yellow">{uiText('m48de72f123e3')}</Text>
        <ConfirmInput defaultChoice="cancel" onCancel={() => setConfirmFull(false)} onConfirm={() => onChange({ ...setShellNetwork(policy, false), mode: "full-access" })} />
      </> : <Select
        defaultValue={policy.mode}
        options={[
          { label: uiText('m3ac3b9cf11de'), value: "read-only" },
          { label: uiText('ma0a5d9bbc54d'), value: "ask" },
          { label: uiText('m107badc68b66'), value: "workspace-write" },
          { label: uiText('m13e095073257'), value: "full-access" },
          { label: policy.web ? uiText('mb2d3b1b827fd') : uiText('m3220b2cd6d4a'), value: "web" },
          ...(policy.mode === "full-access" ? [] : [{ label: policy.shellNetwork === "deny" ? uiText('m596a061ba3f8') : uiText('mafe70e54270c'), value: "shell-network" }]),
          { label: uiText('mfb02c0e3197d'), value: "add-rule" },
          { label: uiText('m69d8d5593c8d'), value: "save-project" },
          ...(rules.length > 0 ? [{ label: uiText('m1ebe4c05a68d'), value: "clear-rules" }] : []),
        ]}
        onChange={(value) => {
          if (value === "full-access") setConfirmFull(true);
          else if (value === "web") onChange({ ...policy, web: !policy.web });
          else if (value === "shell-network") onChange(setShellNetwork(policy, policy.shellNetwork !== "deny"));
          else if (value === "add-rule") setAddingRule(true);
          else if (value === "save-project") onSaveProject?.(policy);
          else if (value === "clear-rules") onChange({ ...policy, commandRules: [] });
          else if (value === "ask" || value === "read-only" || value === "workspace-write") onChange({ ...policy, mode: value });
        }}
      />}
    </CommandSurface>
  );
}
