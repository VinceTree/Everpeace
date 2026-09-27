import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { BashResult } from "../tools/bash.js";
import { retainOutput } from "../tools/command-record.js";
import type { VerificationCommand, VerificationResult, VerificationTier } from "./types.js";
import { verificationFromBash } from "./types.js";

const MAX_MANIFEST_BYTES = 256 * 1024;
const DEFAULT_FAST_TIMEOUT_MS = 60_000;
const DEFAULT_FULL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

interface PackageManifest {
  scripts?: Record<string, unknown>;
  packageManager?: string;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<PackageManifest | undefined> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return undefined;
    const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as { scripts?: unknown; packageManager?: unknown };
    const scripts = record.scripts;
    const packageManager = typeof record.packageManager === "string" ? record.packageManager : undefined;
    return {
      scripts: scripts && typeof scripts === "object" && !Array.isArray(scripts)
        ? scripts as Record<string, unknown>
        : {},
      ...(packageManager ? { packageManager } : {}),
    };
  } catch {
    return undefined;
  }
}

function packageManager(workspacePath: string, manifest: PackageManifest): string {
  const declared = manifest.packageManager?.match(/^(pnpm|npm|yarn|bun)@/iu)?.[1]?.toLowerCase();
  if (declared) return declared;
  const workspace = path.resolve(workspacePath);
  if (fileExists(path.join(workspace, "bun.lockb")) || fileExists(path.join(workspace, "bun.lock"))) return "bun";
  if (fileExists(path.join(workspace, "yarn.lock"))) return "yarn";
  if (fileExists(path.join(workspace, "package-lock.json"))) return "npm";
  return "pnpm";
}

function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

function commandForPackageScript(manager: string, script: string): string {
  return `${manager} run ${script}`;
}

function scriptCommand(
  manifest: PackageManifest,
  workspacePath: string,
  script: string,
  tier: VerificationTier,
): VerificationCommand | undefined {
  if (manifest.scripts?.[script] === undefined) return undefined;
  return {
    id: `node:${script}`,
    label: `Node ${script}`,
    command: commandForPackageScript(packageManager(workspacePath, manifest), script),
    tier,
    timeoutMs: tier === "fast" ? DEFAULT_FAST_TIMEOUT_MS : DEFAULT_FULL_TIMEOUT_MS,
  };
}

/** Discover only conventional, bounded verification commands. It never executes scripts. */
export async function discoverVerificationCommands(workspacePath: string): Promise<VerificationCommand[]> {
  const commands: VerificationCommand[] = [];
  const packageJson = await readJson(path.join(workspacePath, "package.json"));
  if (packageJson) {
    const fast = scriptCommand(packageJson, workspacePath, "typecheck", "fast") ?? scriptCommand(packageJson, workspacePath, "lint", "fast");
    if (fast) commands.push(fast);
    for (const script of ["test", "typecheck", "lint", "build"] as const) {
      const command = scriptCommand(packageJson, workspacePath, script, "full");
      if (command && !commands.some((item) => item.id === command.id)) commands.push(command);
    }
    return commands;
  }

  if (await exists(path.join(workspacePath, "pyproject.toml")) || await exists(path.join(workspacePath, "pytest.ini"))) {
    commands.push({ id: "python:pytest", label: "Python tests", command: "python -m pytest", tier: "full", timeoutMs: DEFAULT_FULL_TIMEOUT_MS });
    return commands;
  }
  if (await exists(path.join(workspacePath, "Cargo.toml"))) {
    commands.push({ id: "rust:check", label: "Cargo check", command: "cargo check", tier: "fast", timeoutMs: DEFAULT_FAST_TIMEOUT_MS });
    commands.push({ id: "rust:test", label: "Cargo tests", command: "cargo test", tier: "full", timeoutMs: DEFAULT_FULL_TIMEOUT_MS });
    return commands;
  }
  if (await exists(path.join(workspacePath, "go.mod"))) {
    commands.push({ id: "go:test", label: "Go tests", command: "go test ./...", tier: "full", timeoutMs: DEFAULT_FULL_TIMEOUT_MS });
  }
  return commands;
}

export function selectVerificationCommand(
  commands: readonly VerificationCommand[],
  tier: VerificationTier,
): VerificationCommand | undefined {
  return commands.find((command) => command.tier === tier)
    ?? (tier === "full" ? commands.find((command) => command.tier === "fast") : undefined);
}

export async function runVerificationCommand(
  command: VerificationCommand,
  run: (command: string, signal?: AbortSignal, timeoutMs?: number) => Promise<BashResult>,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  signal?.throwIfAborted();
  const startedAt = Date.now();
  try {
    const result = await run(command.command, signal, command.timeoutMs);
    signal?.throwIfAborted();
    return verificationFromBash(command, {
      ...result,
      stdout: retainOutput(result.stdout, MAX_OUTPUT_BYTES).text,
      stderr: retainOutput(result.stderr, MAX_OUTPUT_BYTES).text,
    }, Date.now() - startedAt);
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      command,
      passed: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: Date.now() - startedAt,
      timedOut: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function verificationPrompt(result: VerificationResult): string {
  const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");
  return [
    `Verification failed: ${result.command.command} (exit ${result.exitCode ?? "unknown"}).`,
    output ? `Output:\n${output}` : result.error ?? "The command returned no output.",
    "Diagnose the failure, make a focused fix, and verify again. Do not claim completion until the check passes.",
  ].join("\n\n");
}
