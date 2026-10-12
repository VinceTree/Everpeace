import { createHash } from "node:crypto";
import { observeProcessCompletion } from '../tools/process-completion.js';
import { ResourceCleanupError } from '../util/resource-cleanup-error.js';
import { spawnOwned as spawn } from "../tools/owned-process.js";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

const MAX_STATUS_BYTES = 2 * 1024 * 1024;
const MAX_TRACKED_PATHS = 10_000;
const MAX_FINGERPRINT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FINGERPRINT_TOTAL_BYTES = 256 * 1024 * 1024;
const FINGERPRINT_WORKERS = 4;

interface GitResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  truncated: boolean;
}

interface PathState {
  status: string;
  fingerprint: string;
}

interface WorkspaceStatusSnapshot {
  available: boolean;
  complete: boolean;
  paths: Map<string, PathState>;
  reason?: string;
}

export interface WorkspaceChangeObservation {
  available: boolean;
  complete: boolean;
  changedPaths: string[];
  /** Opaque digest of the current scoped Git status and file contents. */
  revision?: string;
  reason?: string;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function runGit(workspacePath: string, args: readonly string[], signal?: AbortSignal): Promise<GitResult> {
    signal?.throwIfAborted();
    const child = spawn("git", ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', ...args], {
      cwd: workspacePath, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const owned = observeProcessCompletion(child, { timeoutMs: 10000, ...(signal ? { signal } : {}) });
    const stdout: Buffer[] = []; let stdoutBytes = 0, stderr = '', truncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      const retained = chunk.subarray(0, Math.max(0, MAX_STATUS_BYTES - stdoutBytes)); stdout.push(retained); stdoutBytes += retained.length;
      if (retained.length !== chunk.length) { truncated = true; owned.stop(); }
    });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });
    const result = await owned.completion;
    if (result.cleanupError) throw result.cleanupError;
    signal?.throwIfAborted();
    return { exitCode: result.exitCode, stdout: Buffer.concat(stdout), stderr: result.error?.message ?? stderr, truncated: truncated || result.timedOut };
}

async function resolveGitRoot(workspacePath: string, signal?: AbortSignal): Promise<{ root?: string; workspace?: string; reason?: string }> {
  const result = await runGit(workspacePath, ["rev-parse", "--show-toplevel"], signal);
  if (result.exitCode !== 0) return { reason: result.stderr.trim() || "Workspace is not a Git repository" };
  const reportedRoot = result.stdout.toString("utf8").trim();
  if (!reportedRoot) return { reason: "Git did not report a repository root" };
  try {
    const [root, workspace] = await Promise.all([fs.realpath(reportedRoot), fs.realpath(workspacePath)]);
    if (!inside(root, workspace)) return { reason: "Workspace is outside the reported Git repository" };
    return { root, workspace };
  } catch (error) {
    if (error instanceof ResourceCleanupError || signal?.aborted) throw error;
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

function parsePorcelainStatus(value: Buffer): Array<{ path: string; status: string }> {
  const records = value.toString("utf8").split("\0");
  const result: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") throw new Error("Git returned an invalid porcelain status record");
    const status = record.slice(0, 2);
    const previousPath = status.includes('R') || status.includes('C') ? records[++index] : undefined;
    if ((status.includes('R') || status.includes('C')) && !previousPath) throw new Error('Git returned an incomplete rename status record');
    if (/\.everpeace-(?:recovery|stage|batch)-/u.test(record.slice(3)) || previousPath && /\.everpeace-(?:recovery|stage|batch)-/u.test(previousPath)) continue;
    result.push({ status, path: record.slice(3) });
    if (previousPath) result.push({ status: `${status}:source`, path: previousPath });

  }
  return result;
}

async function fingerprintPath(root: string, relativePath: string, budget: { bytes: number }, signal?: AbortSignal): Promise<{ value: string; complete: boolean }> {
  signal?.throwIfAborted();
  const target = path.resolve(root, relativePath);
  if (!inside(path.resolve(root), target)) return { value: "outside", complete: false };
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) return { value: `symlink:${await fs.readlink(target)}`, complete: true };
    if (!stat.isFile()) return { value: `other:${stat.mode}:${stat.size}`, complete: true };
    if (stat.size > MAX_FINGERPRINT_FILE_BYTES || budget.bytes + stat.size > MAX_FINGERPRINT_TOTAL_BYTES) {
      return { value: `limited:${stat.size}:${stat.mtimeMs}`, complete: false };
    }
    budget.bytes += stat.size;
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(target, signal ? { signal } : {});
      stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
      stream.once("error", reject);
      stream.once("end", resolve);
    });
    return { value: `file:${stat.size}:${hash.digest("hex")}`, complete: true };
  } catch (error) {
    if (error instanceof ResourceCleanupError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: "missing", complete: true };
    return { value: `error:${error instanceof Error ? error.message : String(error)}`, complete: false };
  }
}

async function mapConcurrent<T, R>(values: readonly T[], workers: number, run: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  results.length = values.length;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await run(values[index]!);
    }
  }));
  return results;
}

function revisionOf(paths: ReadonlyMap<string, PathState>): string {
  const hash = createHash("sha256");
  for (const [name, state] of [...paths].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(name).update("\0").update(state.status).update("\0").update(state.fingerprint).update("\0");
  }
  return hash.digest("hex");
}

async function captureStatus(
  workspacePath: string,
  gitRoot: string,
  workspaceRoot: string,
  explicitPaths: ReadonlySet<string> = new Set(),
  signal?: AbortSignal,
): Promise<WorkspaceStatusSnapshot> {
  // The pathspec keeps sibling directories out of the task snapshot. Porcelain
  // paths are still repository-root relative, so fingerprints must use gitRoot.
  const result = await runGit(workspacePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no", "--", "."], signal);
  if (result.exitCode !== 0) {
    return {
      available: false,
      complete: false,
      paths: new Map(),
      reason: result.stderr.trim() || "Workspace is not a Git repository",
    };
  }
  if (result.truncated) {
    return { available: true, complete: false, paths: new Map(), reason: "Git status exceeded the tracking limit" };
  }
  let records: Array<{ path: string; status: string }>;
  try { records = parsePorcelainStatus(result.stdout); }
  catch (error) {
    return { available: true, complete: false, paths: new Map(), reason: error instanceof Error ? error.message : String(error) };
  }
  if (records.length > MAX_TRACKED_PATHS) {
    return { available: true, complete: false, paths: new Map(), reason: "Git status contains too many changed paths to track safely" };
  }
  const candidates = new Map<string, { root: string; path: string; status: string }>();
  for (const record of records) {
    const target = path.resolve(gitRoot, record.path);
    if (!inside(workspaceRoot, target)) continue;
    const scopedPath = path.relative(workspaceRoot, target).split(path.sep).join("/");
    if (scopedPath) candidates.set(scopedPath, { root: gitRoot, path: record.path, status: record.status });
  }
  for (const scopedPath of explicitPaths) {
    candidates.set(scopedPath, { root: workspaceRoot, path: scopedPath, status: "explicit" });
  }
  const ordered = [...candidates].sort(([left], [right]) => left.localeCompare(right));
  const budget = { bytes: 0 };
  const fingerprints = await mapConcurrent(ordered, FINGERPRINT_WORKERS, async ([scopedPath, candidate]) => ({
    scopedPath,
    status: candidate.status,
    fingerprint: await fingerprintPath(candidate.root, candidate.path, budget, signal),
  }));
  const paths = new Map<string, PathState>();
  let complete = true;
  for (const item of fingerprints) {
    complete &&= item.fingerprint.complete;
    paths.set(item.scopedPath, { status: item.status, fingerprint: item.fingerprint.value });
  }
  return {
    available: true,
    complete,
    paths,
    ...(complete ? {} : { reason: "One or more changed files exceeded the fingerprint limits" }),
  };
}

/** Tracks changes relative to the dirty state that existed when a coding task began. */
export class WorkspaceChangeTracker {
  readonly #workspacePath: string;
  #baseline: WorkspaceStatusSnapshot | undefined;
  #gitRoot: string | undefined;
  #workspaceRoot: string | undefined;
  readonly #explicitPaths = new Set<string>();

  constructor(workspacePath: string) { this.#workspacePath = workspacePath; }

  async begin(signal?: AbortSignal): Promise<WorkspaceChangeObservation> {
    const context = await resolveGitRoot(this.#workspacePath, signal);
    this.#gitRoot = context.root;
    this.#workspaceRoot = context.workspace;
    this.#baseline = context.root && context.workspace
      ? await captureStatus(this.#workspacePath, context.root, context.workspace, undefined, signal)
      : { available: false, complete: false, paths: new Map(), reason: context.reason ?? "Workspace tracking is unavailable" };
    return this.#compare(this.#baseline);
  }

  /** Include host-observed edit targets even when Git ignores them. */
  async trackPaths(paths: readonly string[], signal?: AbortSignal): Promise<void> {
    if (!this.#baseline) await this.begin(signal);
    if (!this.#baseline || !this.#workspaceRoot) return;
    const workspaceRoot = this.#workspaceRoot;
    const requestedPaths = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
    const budget = { bytes: 0 };
    const tracked = await mapConcurrent(requestedPaths, FINGERPRINT_WORKERS, async (requested) => {
      const target = path.resolve(workspaceRoot, requested);
      if (!inside(workspaceRoot, target)) return undefined;
      const scoped = path.relative(workspaceRoot, target).split(path.sep).join("/");
      if (!scoped) return undefined;
      const fingerprint = await fingerprintPath(workspaceRoot, scoped, budget, signal);
      return { scoped, fingerprint };
    });
    for (const item of tracked) {
      if (!item) continue;
      this.#explicitPaths.add(item.scoped);
      this.#baseline.paths.set(item.scoped, { status: "explicit", fingerprint: item.fingerprint.value });
      if (!item.fingerprint.complete) this.#baseline.complete = false;
    }
  }

  async observe(signal?: AbortSignal): Promise<WorkspaceChangeObservation> {
    if (!this.#baseline) await this.begin();
    if (!this.#gitRoot || !this.#workspaceRoot) return this.#compare({
      available: false,
      complete: false,
      paths: new Map(),
      reason: this.#baseline?.reason ?? "Workspace tracking is unavailable",
    });
    const current = await captureStatus(this.#workspacePath, this.#gitRoot, this.#workspaceRoot, this.#explicitPaths, signal);
    return this.#compare(current);
  }

  #compare(current: WorkspaceStatusSnapshot): WorkspaceChangeObservation {
    const baseline = this.#baseline;
    if (!baseline || !baseline.available || !current.available) {
      return {
        available: false,
        complete: false,
        changedPaths: [],
        reason: current.reason ?? baseline?.reason ?? "Workspace tracking is unavailable",
      };
    }
    if (!baseline.complete || !current.complete) {
      return {
        available: true,
        complete: false,
        changedPaths: [],
        reason: current.reason ?? baseline.reason ?? "Workspace tracking is incomplete",
      };
    }
    const changedPaths = new Set<string>();
    for (const candidate of new Set([...baseline.paths.keys(), ...current.paths.keys()])) {
      const before = baseline.paths.get(candidate);
      const after = current.paths.get(candidate);
      if (before?.status !== after?.status || before?.fingerprint !== after?.fingerprint) changedPaths.add(candidate);
    }
    return {
      available: true,
      complete: true,
      changedPaths: [...changedPaths].sort((left, right) => left.localeCompare(right)),
      revision: revisionOf(current.paths),
    };
  }
}

export const workspaceTrackerLimits = {
  maxStatusBytes: MAX_STATUS_BYTES,
  maxTrackedPaths: MAX_TRACKED_PATHS,
  maxFingerprintFileBytes: MAX_FINGERPRINT_FILE_BYTES,
  maxFingerprintTotalBytes: MAX_FINGERPRINT_TOTAL_BYTES,
  fingerprintWorkers: FINGERPRINT_WORKERS,
} as const;
