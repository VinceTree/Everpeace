/**
 * User-facing permission profiles. The names mirror Codex's practical
 * profiles while keeping the policy process-local for this application.
 */
export type PermissionMode = "read-only" | "ask" | "workspace-write" | "full-access";

export interface PermissionPolicy {
  mode: PermissionMode;
  web: boolean;
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
