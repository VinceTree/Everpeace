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
  /** Omitted means the selected native profile controls shell networking. */
  shellNetwork?: "deny";
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
    const root = env.APPDATA?.trim() || path.win32.join(homeDirectory, "AppData", "Roaming");
    return path.win32.join(root, "Everpeace", "permissions.json");
  }
  if (platform === "darwin") return path.join(homeDirectory, "Library", "Application Support", "Everpeace", "permissions.json");
  const root = env.XDG_CONFIG_HOME?.trim() || path.join(homeDirectory, ".config");
  return path.join(root, "everpeace", "permissions.json");
}

export function projectPermissionPath(workspacePath: string): string {
  const pathApi = path.win32.isAbsolute(workspacePath) && !path.posix.isAbsolute(workspacePath)
    ? path.win32
    : path;
  return pathApi.join(workspacePath, ".everpeace", "permissions.json");
}

function isPolicy(value: unknown): value is PermissionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.mode !== "read-only" && record.mode !== "ask" && record.mode !== "workspace-write" && record.mode !== "full-access") return false;
  if (typeof record.web !== "boolean") return false;
  if (record.shellNetwork !== undefined && record.shellNetwork !== "deny") return false;
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
  return {
    mode: policy.mode,
    web: policy.web,
    ...(policy.shellNetwork === "deny" ? { shellNetwork: "deny" as const } : {}),
    ...(rules.length ? { commandRules: rules } : {}),
  };
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
          ...(result.shellNetwork === "deny" || next.shellNetwork === "deny" ? { shellNetwork: "deny" as const } : {}),
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

export interface CommandAnalysis {
  segments: readonly string[];
  unresolved: boolean;
}

/** Split top-level shell chains conservatively; ambiguous nesting requires approval. */
export function analyzeCommand(command: string): CommandAnalysis {
  const segments: string[] = [];
  let current = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;
  let unresolved = false;
  const push = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = "";
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    const next = command[index + 1];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "single") {
      current += character;
      escaped = true;
      continue;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
      current += character;
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      current += character;
      continue;
    }
    if (quote !== "single" && (character === "`" || (character === "$" && next === "("))) {
      unresolved = true;
    }
    if (!quote && (character === "(" || character === ")" || character === "{" || character === "}")) {
      unresolved = true;
    }
    if (!quote && (character === ";" || character === "\n" || character === "\r" || character === "|" || character === "&")) {
      push();
      if (character === "&" && next !== "&") unresolved = true;
      if ((character === "|" || character === "&") && next === character) index += 1;
      continue;
    }
    current += character;
  }
  push();
  if (quote || escaped || segments.length === 0) unresolved = true;
  if (segments.some((segment) => /(?:^|[\\/\s"'])(?:bash|sh|zsh|fish|cmd|powershell|pwsh|node|python\d*|perl|ruby)(?:\.exe)?(?=$|[\s"'])/iu.test(segment)
    && /(?:^|\s)(?:-c|\/c|-command|-e)(?:\s|$)/iu.test(segment))) unresolved = true;
  return { segments, unresolved };
}

export function permissionPolicyRevision(policy: PermissionPolicy): string {
  return JSON.stringify({
    mode: policy.mode,
    web: policy.web,
    shellNetwork: policy.shellNetwork ?? "profile-default",
    commandRules: [...(policy.commandRules ?? [])]
      .map((rule) => ({ prefix: rule.prefix.trim(), action: rule.action }))
      .sort((left, right) => left.prefix.localeCompare(right.prefix) || left.action.localeCompare(right.action)),
  });
}

function segmentPermission(
  segment: string,
  rules: readonly CommandPrefixRule[],
): CommandRuleAction | undefined {
  const matching = rules
    .filter((rule) => matchesPrefix(segment, rule.prefix))
    .sort((left, right) => right.prefix.trim().length - left.prefix.trim().length);
  const selected = matching[0];
  if (!selected) return undefined;
  const sameLength = matching.filter((rule) => rule.prefix.trim().length === selected.prefix.trim().length);
  if (sameLength.some((rule) => rule.action === "deny")) return "deny";
  if (sameLength.some((rule) => rule.action === "ask")) return "ask";
  return "allow";
}

/** Resolve the persisted command rule before the profile's global gate. */
export function commandPermission(
  command: string,
  policy: PermissionPolicy,
): "deny" | "ask" | "allow" {
  const profilePermission = bashPermission(policy);
  if (profilePermission === "deny") return "deny";
  const rules = policy.commandRules ?? [];
  const analysis = analyzeCommand(command);
  let result: "ask" | "allow" = profilePermission;
  for (const segment of analysis.segments) {
    const selected = segmentPermission(segment, rules);
    if (selected === "deny") return "deny";
    if (selected === "ask") result = "ask";
  }
  // A deny rule embedded behind a wrapper or nested interpreter must not be
  // downgraded to a user-overridable approval.
  if (analysis.unresolved && rules.some((rule) => {
    const prefix = rule.prefix.trim().toLowerCase();
    return rule.action === "deny" && prefix.length > 0 && command.toLowerCase().includes(prefix);
  })) return "deny";
  if (analysis.unresolved) return "ask";
  return result;
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
