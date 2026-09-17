export type PermissionMode = "read-only" | "ask" | "full-access";

export interface PermissionPolicy {
  mode: PermissionMode;
  web: boolean;
}

export function defaultPermissions(): PermissionPolicy {
  return { mode: "ask", web: true };
}

export function bashPermission(policy: PermissionPolicy): "deny" | "ask" | "allow" {
  if (policy.mode === "read-only") return "deny";
  return policy.mode === "full-access" ? "allow" : "ask";
}
