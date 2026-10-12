import { readdirSync, existsSync } from "node:fs";
import { sensitivePath } from "../permissions/sensitive-access.js";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PermissionPolicy } from "../permissions/policy.js";
import { codexSandboxProfile } from "../permissions/policy.js";

export type NativePermissionProfile = ":read-only" | ":workspace" | ":danger-full-access";
export type SandboxPathAccess = "read" | "none" | "write";

export interface SandboxPathRule {
  path: string;
  access: SandboxPathAccess;
}

/** Immutable policy captured immediately before one model command starts. */
export interface EffectiveSandboxPolicy {
  launchRoot?: string;
  backend: "codex-cli";
  permissionProfile: NativePermissionProfile;
  workspaceRoots: readonly string[];
  readableRoots: readonly string[];
  pathRules: readonly SandboxPathRule[];
  materializedControlPaths: readonly string[];
  networkMode: "profile-default" | "deny";
  environmentPolicy: "filtered-inherit";
  approvalScope: "per-command" | "policy-rules" | "full-access";
  revision: string;
}

const CONTROL_DIRECTORIES = [".git", ".codex", ".agents", ".everpeace"] as const;
export const MODEL_WORKSPACE_PROFILE = "everpeace-model-workspace";
export const LSP_READ_ONLY_PROFILE = "everpeace-lsp-readonly";

export interface LspSandboxPolicy {
  backend: "codex-cli";
  permissionProfile: typeof LSP_READ_ONLY_PROFILE;
  workspaceRoot: string;
  readableRoots: readonly string[];
  deniedRoots: readonly string[];
  networkMode: "deny";
  environmentPolicy: "filtered-inherit";
  revision: string;
}

function pathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function comparable(value: string, platform: NodeJS.Platform): string {
  const normalized = pathApi(platform).resolve(value).replace(/[\\/]+$/u, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function canonicalExistingPath(value: string, platform: NodeJS.Platform): string {
  const resolved = pathApi(platform).resolve(value);
  try { return realpathSync.native(resolved); } catch { return resolved; }
}

function isWithin(candidate: string, root: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform);
  const relative = api.relative(comparable(root, platform), comparable(candidate, platform));
  return relative === "" || (!relative.startsWith("..") && !api.isAbsolute(relative));
}

function overlaps(first: string, second: string, platform: NodeJS.Platform): boolean {
  return isWithin(first, second, platform) || isWithin(second, first, platform);
}

export function applicationStateRoots(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): readonly string[] {
  const api = pathApi(platform);
  if (platform === "win32") {
    const root = env.APPDATA?.trim() || api.join(homeDirectory, "AppData", "Roaming");
    return [api.join(root, "Everpeace")];
  }
  if (platform === "darwin") {
    return [api.join(homeDirectory, "Library", "Application Support", "Everpeace")];
  }
  const config = env.XDG_CONFIG_HOME?.trim() || api.join(homeDirectory, ".config");
  const state = env.XDG_STATE_HOME?.trim() || api.join(homeDirectory, ".local", "state");
  return [...new Set([api.join(config, "everpeace"), api.join(state, "everpeace")])];
}

export function sensitiveHomePaths(homeDirectory: string, platform: NodeJS.Platform): string[] {
  const api = pathApi(platform);
  return ['.ssh', '.aws', '.azure', '.kube', '.npmrc', '.netrc', '.pypirc', '.git-credentials'].map(name => api.join(homeDirectory, name));
}

export function sensitiveSandboxPaths(workspace: string): string[] {
  if (!existsSync(workspace)) return [];
  const denied: string[] = []; let count = 0;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++count > 10_000) throw new Error('Sensitive-path scan incomplete; sandbox launch blocked');
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || sensitivePath(entry.name) || /\.everpeace-(?:recovery|stage)-/u.test(entry.name)) denied.push(target);
      else if (entry.isDirectory() && !['.git', '.everpeace', '.codex', '.agents', 'node_modules'].includes(entry.name)) visit(target);
    }
  };
  visit(workspace); return denied;
}

export function createEffectiveSandboxPolicy(
  permissionPolicy: PermissionPolicy,
  workspaceRoot: string,
  readableRoots: readonly string[] = [],
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    isolation?: { deniedRoots: readonly string[]; writableRoot: string; traversalRoots?: readonly string[] };
  } = {},
): EffectiveSandboxPolicy {
  const platform = options.platform ?? process.platform;
  const api = pathApi(platform);
  const workspace = canonicalExistingPath(workspaceRoot, platform);
  const permissionProfile = codexSandboxProfile(permissionPolicy);
  const normalizedReadableRoots = [...new Set(readableRoots.map((root) => canonicalExistingPath(root, platform)))];
  const controlPaths = CONTROL_DIRECTORIES.map((name) => api.join(workspace, name));
  const globalState = applicationStateRoots(platform, options.env ?? process.env, options.homeDirectory ?? os.homedir())
    .map((root) => canonicalExistingPath(root, platform))
    .filter((root) => !isWithin(workspace, root, platform));
  const pathRules: SandboxPathRule[] = permissionProfile === ":danger-full-access"
    ? []
    : [
        ...controlPaths.map((rulePath): SandboxPathRule => ({ path: rulePath, access: "read" })),
        ...globalState.map((rulePath): SandboxPathRule => ({ path: rulePath, access: "none" })),
        ...[...sensitiveSandboxPaths(workspace), ...sensitiveHomePaths(options.homeDirectory ?? os.homedir(), platform)].map((rulePath): SandboxPathRule => ({ path: rulePath, access: "none" })),
      ];
  if (options.isolation) {
    if (permissionProfile === ":danger-full-access") throw new Error("Team members cannot use full access");
    pathRules.unshift(...options.isolation.deniedRoots.map((root): SandboxPathRule => ({ path: canonicalExistingPath(root, platform), access: "none" })), ...(options.isolation.traversalRoots ?? []).map((root): SandboxPathRule => ({ path: canonicalExistingPath(root, platform), access: "read" })), { path: canonicalExistingPath(options.isolation.writableRoot, platform), access: "write" });
  }
  const materializedControlPaths = permissionProfile === ":workspace"
    ? [api.join(workspace, ".everpeace")]
    : [];
  const approvalScope = permissionPolicy.mode === "full-access"
    ? "full-access"
    : permissionPolicy.mode === "ask" || permissionPolicy.mode === "read-only"
      ? "per-command"
      : "policy-rules";
  const revision = JSON.stringify({
    permissionPolicy,
    permissionProfile,
    workspace,
    readableRoots: normalizedReadableRoots,
    pathRules,
    ...(options.isolation?.traversalRoots?.[0] ? { launchRoot: canonicalExistingPath(options.isolation.traversalRoots[0], platform) } : {}),
    networkMode: permissionPolicy.shellNetwork === "allow" || (permissionPolicy.mode === "full-access" && permissionPolicy.shellNetwork !== "deny") ? "profile-default" : "deny",
  });
  return Object.freeze({
    backend: "codex-cli" as const,
    permissionProfile,
    workspaceRoots: Object.freeze([workspace]),
    ...(options.isolation?.traversalRoots?.[0] ? { launchRoot: canonicalExistingPath(options.isolation.traversalRoots[0], platform) } : {}),
    readableRoots: Object.freeze(normalizedReadableRoots),
    pathRules: Object.freeze(pathRules.map((rule) => Object.freeze({ ...rule }))),
    materializedControlPaths: Object.freeze(materializedControlPaths),
    networkMode: permissionPolicy.shellNetwork === "allow" || (permissionPolicy.mode === "full-access" && permissionPolicy.shellNetwork !== "deny") ? "profile-default" : "deny",
    environmentPolicy: "filtered-inherit" as const,
    approvalScope,
    revision,
  });
}

/** Missing Windows deny targets are not protected, so the host creates owned control roots first. */
export function materializeSandboxControlPaths(policy: EffectiveSandboxPolicy): void {
  for (const controlPath of policy.materializedControlPaths) {
    mkdirSync(controlPath, { recursive: true });
    const stats = lstatSync(controlPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Sandbox control path must be a real directory: ${controlPath}`);
    }
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Build a complete named profile override so user config cannot add permissions to it. */
export function nativePermissionProfileArgs(policy: EffectiveSandboxPolicy): string[] {
  if (policy.permissionProfile === ":danger-full-access") return ["-P", policy.permissionProfile];
  const baseProfile = policy.pathRules.some((rule) => rule.access === "write") ? ":read-only" : policy.permissionProfile;
  const filesystem = policy.pathRules
    .map((rule) => `${tomlString(rule.path)}=${tomlString(rule.access)}`)
    .join(",");
  return [
    "-P",
    MODEL_WORKSPACE_PROFILE,
    "-c",
    `default_permissions=${tomlString(MODEL_WORKSPACE_PROFILE)}`,
    "-c",
    `permissions.${MODEL_WORKSPACE_PROFILE}={extends=${tomlString(baseProfile)},filesystem={${filesystem}}}`,
  ];
}

/** Build the stricter process policy used only for configured language servers. */
export function createLspSandboxPolicy(
  workspaceRoot: string,
  readableRoots: readonly string[] = [],
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    homeDirectory?: string;
  } = {},
): LspSandboxPolicy {
  const platform = options.platform ?? process.platform;
  const workspace = canonicalExistingPath(workspaceRoot, platform);
  const deniedRoots = [
    ...CONTROL_DIRECTORIES.map((name) => pathApi(platform).join(workspace, name)),
    ...sensitiveSandboxPaths(workspace),
    ...sensitiveHomePaths(options.homeDirectory ?? os.homedir(), platform),
    ...applicationStateRoots(platform, options.env ?? process.env, options.homeDirectory ?? os.homedir()),
  ].map((root) => canonicalExistingPath(root, platform));
  const roots = [...new Set([workspace, ...readableRoots.map((root) => canonicalExistingPath(root, platform))])];
  for (const root of roots.slice(1)) {
    if (deniedRoots.some((denied) => overlaps(root, denied, platform))) {
      throw new Error(`Language-server read root overlaps protected application state: ${root}`);
    }
  }
  const revision = JSON.stringify({ workspace, readableRoots: roots, deniedRoots, networkMode: "deny" });
  return Object.freeze({
    backend: "codex-cli" as const,
    permissionProfile: LSP_READ_ONLY_PROFILE,
    workspaceRoot: workspace,
    readableRoots: Object.freeze(roots),
    deniedRoots: Object.freeze(deniedRoots),
    networkMode: "deny" as const,
    environmentPolicy: "filtered-inherit" as const,
    revision,
  });
}

export function nativeLspPermissionProfileArgs(policy: LspSandboxPolicy, launcherRoot?: string): string[] {
  if (launcherRoot && (!path.isAbsolute(launcherRoot)
    || overlaps(launcherRoot, policy.workspaceRoot, process.platform)
    || policy.deniedRoots.some((denied) => overlaps(launcherRoot, denied, process.platform)))) {
    throw new Error("Language-server launcher root must be separate from workspace and protected state");
  }
  const filesystem = [
    ...policy.readableRoots.map((root) => `${tomlString(root)}=${tomlString("read")}`),
    ...(launcherRoot ? [`${tomlString(launcherRoot)}=${tomlString("read")}`] : []),
    ...policy.deniedRoots.map((root) => `${tomlString(root)}=${tomlString("none")}`),
  ].join(",");
  return [
    "-P",
    policy.permissionProfile,
    "-c",
    `default_permissions=${tomlString(policy.permissionProfile)}`,
    "-c",
    `permissions.${policy.permissionProfile}={extends=":read-only",filesystem={${filesystem}}}`,
  ];
}

/** Filter inherited variables before the Node launcher itself starts. Values are never logged. */
export function modelShellEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name, value]) => {
    if (value === undefined) return false;
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/iu.test(name)) return false;
    // These can execute code before the OS sandbox is established or load shell startup files.
    return !/^(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|BASH_FUNC_.*|LD_.*|DYLD_.*|PYTHONPATH|PYTHONSTARTUP)$/iu.test(name);
  }));
}

/** Protect control metadata through the in-process editor as well as the shell backend. */
export function isProtectedPatchPath(relative: string): boolean {
  return relative.split(/[\\/]/u).some((part) =>
    CONTROL_DIRECTORIES.includes(part.replace(/[ .]+$/u, "").toLowerCase() as typeof CONTROL_DIRECTORIES[number]));
}
