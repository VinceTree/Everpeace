/**
 * User-facing permission profiles. The names mirror Codex's practical
 * profiles while keeping project-provided policy fail-closed.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

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

const POLICY_VERSION = 1;
const policyWriteQueues = new Map<string, Promise<void>>();

interface StoredPermissionPolicy {
  version: typeof POLICY_VERSION;
  policy: PermissionPolicy;
}

export function defaultPermissionPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  if (platform === "win32") {
    const root = env.APPDATA?.trim() || path.join(homeDirectory, "AppData", "Roaming");
    return path.join(root, "Everpeace", "permissions.json");
  }
  if (platform === "darwin") return path.join(homeDirectory, "Library", "Application Support", "Everpeace", "permissions.json");
  const root = env.XDG_CONFIG_HOME?.trim() || path.join(homeDirectory, ".config");
  return path.join(root, "everpeace", "permissions.json");
}

export function projectPermissionPath(workspacePath: string): string {
  return path.join(workspacePath, ".everpeace", "permissions.json");
}

function isPolicy(value: unknown): value is PermissionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.mode !== "read-only" && record.mode !== "ask" && record.mode !== "workspace-write" && record.mode !== "full-access") return false;
  if (typeof record.web !== "boolean") return false;
  if (record.commandRules !== undefined && (!Array.isArray(record.commandRules) || !record.commandRules.every((rule) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return false;
    const item = rule as Record<string, unknown>;
    return typeof item.prefix === "string" && item.prefix.trim().length > 0
      && (item.action === "allow" || item.action === "ask" || item.action === "deny");
  }))) return false;
  return true;
}

function normalizePolicy(policy: PermissionPolicy): PermissionPolicy {
  const rules = (policy.commandRules ?? [])
    .map((rule) => ({ prefix: rule.prefix.trim(), action: rule.action }))
    .filter((rule) => rule.prefix.length > 0);
  return { mode: policy.mode, web: policy.web, ...(rules.length ? { commandRules: rules } : {}) };
}

function restrictiveMode(left: PermissionMode, right: PermissionMode): PermissionMode {
  const rank: Record<PermissionMode, number> = { "read-only": 0, ask: 1, "workspace-write": 2, "full-access": 3 };
  return rank[left] <= rank[right] ? left : right;
}

export async function loadPermissionPolicy(
  workspacePath: string,
  options: { userPath?: string; projectPath?: string } = {},
): Promise<PermissionPolicy> {
  const paths = [options.userPath ?? defaultPermissionPath(), options.projectPath ?? projectPermissionPath(workspacePath)];
  let result = defaultPermissions();
  for (const [index, filePath] of paths.entries()) {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const record = parsed as Partial<StoredPermissionPolicy>;
      if (record.version !== POLICY_VERSION || !isPolicy(record.policy)) continue;
      const next = normalizePolicy(record.policy);
      if (index === 0) {
        result = next;
      } else {
        // Project files are untrusted input: they may restrict a user policy,
        // but never elevate it or grant a more permissive command rule.
        const projectRules = (next.commandRules ?? []).filter((rule) => rule.action !== "allow");
        const rules = [...(result.commandRules ?? []), ...projectRules];
        result = {
          mode: restrictiveMode(result.mode, next.mode),
          web: result.web && next.web,
          ...(rules.length ? { commandRules: rules } : {}),
        };
      }
    } catch {
      // Missing or malformed policy files are isolated and fall back safely.
    }
  }
  return result;
}

export async function savePermissionPolicy(
  policy: PermissionPolicy,
  workspacePath: string,
  options: { userPath?: string; projectPath?: string; scope?: "user" | "project" } = {},
): Promise<void> {
  const scope = options.scope ?? "user";
  const filePath = scope === "project"
    ? options.projectPath ?? projectPermissionPath(workspacePath)
    : options.userPath ?? defaultPermissionPath();
  const normalized = normalizePolicy(policy);
  const previous = policyWriteQueues.get(filePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: POLICY_VERSION, policy: normalized }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, filePath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  });
  policyWriteQueues.set(filePath, current);
  try {
    await current;
  } finally {
    if (policyWriteQueues.get(filePath) === current) policyWriteQueues.delete(filePath);
  }
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

/** Resolve the persisted command rule before the profile's global gate. */
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
