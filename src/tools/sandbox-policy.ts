import { lstatSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PermissionPolicy } from "../permissions/policy.js";
import { codexSandboxProfile } from "../permissions/policy.js";

export type NativePermissionProfile = ":read-only" | ":workspace" | ":danger-full-access";
export type SandboxPathAccess = "read" | "none";

export interface SandboxPathRule {
  path: string;
  access: SandboxPathAccess;
}

/** Immutable policy captured immediately before one model command starts. */
export interface EffectiveSandboxPolicy {
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

function pathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function comparable(value: string, platform: NodeJS.Platform): string {
  const normalized = pathApi(platform).resolve(value).replace(/[\\/]+$/u, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(candidate: string, root: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform);
  const relative = api.relative(comparable(root, platform), comparable(candidate, platform));
  return relative === "" || (!relative.startsWith("..") && !api.isAbsolute(relative));
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

export function createEffectiveSandboxPolicy(
  permissionPolicy: PermissionPolicy,
  workspaceRoot: string,
  readableRoots: readonly string[] = [],
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    homeDirectory?: string;
  } = {},
): EffectiveSandboxPolicy {
  const platform = options.platform ?? process.platform;
  const api = pathApi(platform);
  const workspace = api.resolve(workspaceRoot);
  const permissionProfile = codexSandboxProfile(permissionPolicy);
  const normalizedReadableRoots = [...new Set(readableRoots.map((root) => api.resolve(root)))];
  const controlPaths = CONTROL_DIRECTORIES.map((name) => api.join(workspace, name));
  const globalState = applicationStateRoots(platform, options.env ?? process.env, options.homeDirectory ?? os.homedir())
    .filter((root) => !isWithin(workspace, root, platform));
  const pathRules = permissionProfile === ":danger-full-access"
    ? []
    : [
        ...controlPaths.map((rulePath): SandboxPathRule => ({ path: rulePath, access: "read" })),
        ...globalState.map((rulePath): SandboxPathRule => ({ path: rulePath, access: "none" })),
      ];
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
    networkMode: permissionPolicy.shellNetwork ?? "profile-default",
  });
  return Object.freeze({
    backend: "codex-cli" as const,
    permissionProfile,
    workspaceRoots: Object.freeze([workspace]),
    readableRoots: Object.freeze(normalizedReadableRoots),
    pathRules: Object.freeze(pathRules.map((rule) => Object.freeze({ ...rule }))),
    materializedControlPaths: Object.freeze(materializedControlPaths),
    networkMode: permissionPolicy.shellNetwork ?? "profile-default",
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
  if (policy.permissionProfile !== ":workspace") return ["-P", policy.permissionProfile];
  const filesystem = policy.pathRules
    .map((rule) => `${tomlString(rule.path)}=${tomlString(rule.access)}`)
    .join(",");
  return [
    "-P",
    MODEL_WORKSPACE_PROFILE,
    "-c",
    `default_permissions=${tomlString(MODEL_WORKSPACE_PROFILE)}`,
    "-c",
    `permissions.${MODEL_WORKSPACE_PROFILE}={extends=\":workspace\",filesystem={${filesystem}}}`,
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
