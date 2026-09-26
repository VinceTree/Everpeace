/**
 * User-facing permission profiles. The names mirror Codex's practical
 * profiles while keeping the policy process-local for this application.
 */
export type PermissionMode = "read-only" | "ask" | "workspace-write" | "full-access";
export type CommandRuleAction = "allow" | "ask" | "deny";

export interface CommandPrefixRule {
  prefix: string;
  action: CommandRuleAction;
}

export interface PermissionPolicy {
  mode: PermissionMode;
  web: boolean;
  commandRules?: readonly CommandPrefixRule[];
}

export function defaultPermissions(): PermissionPolicy {
  // Codex's useful default is autonomous work in the current workspace. The
  // explicit `ask` profile remains available for command-by-command review.
  return { mode: "workspace-write", web: true };
}

export function bashPermission(policy: PermissionPolicy): "deny" | "ask" | "allow" {
  if (policy.mode === "read-only" || policy.mode === "ask") return "ask";
  return "allow";
}

function matchesPrefix(command: string, prefix: string): boolean {
  const normalizedCommand = command.trim();
  const normalizedPrefix = prefix.trim();
  return normalizedPrefix.length > 0
    && (normalizedCommand === normalizedPrefix || normalizedCommand.startsWith(`${normalizedPrefix} `));
}

/** Resolve the process-local command rule before the profile's global gate. */
export function commandPermission(
  command: string,
  policy: PermissionPolicy,
): "deny" | "ask" | "allow" {
  const profilePermission = bashPermission(policy);
  if (profilePermission === "deny") return "deny";
  const rules = policy.commandRules ?? [];
  const matching = rules
    .filter((rule) => matchesPrefix(command, rule.prefix))
    .sort((left, right) => right.prefix.trim().length - left.prefix.trim().length);
  const selected = matching[0];
  if (!selected) return profilePermission;
  const sameLength = matching.filter((rule) => rule.prefix.trim().length === selected.prefix.trim().length);
  if (sameLength.some((rule) => rule.action === "deny")) return "deny";
  if (sameLength.some((rule) => rule.action === "ask")) return "ask";
  if (profilePermission === "ask" && selected.action === "allow") return "ask";
  return selected.action;
}

export function webPermission(policy: PermissionPolicy): "deny" | "ask" | "allow" {
  if (!policy.web) return "deny";
  return policy.mode === "workspace-write" || policy.mode === "full-access" ? "allow" : "ask";
}

export function mcpPermission(policy: PermissionPolicy): "ask" | "allow" {
  // MCP servers can perform side effects outside the workspace. Keep this
  // approval surface separate from both Bash and the built-in web toggle.
  return policy.mode === "full-access" ? "allow" : "ask";
}

export function codexSandboxProfile(
  policy: PermissionPolicy,
): ":read-only" | ":workspace" | ":danger-full-access" {
  if (policy.mode === "read-only") return ":read-only";
  if (policy.mode === "full-access") return ":danger-full-access";
  return ":workspace";
}
