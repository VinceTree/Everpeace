import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { BenchmarkTask, BenchmarkVerificationResult } from "./types.js";
import { runBenchmarkVerification } from "./runner.js";
import { stopProcessTree } from "../tools/process-cancel.js";
import { BoundedOutputBuffer } from "../tools/command-record.js";

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const MAX_COMMAND_OUTPUT = 256 * 1024;

function run(command: string, args: readonly string[], cwd: string | undefined, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        ...(cwd === undefined ? {} : { cwd }),
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout = new BoundedOutputBuffer(MAX_COMMAND_OUTPUT);
    const stderr = new BoundedOutputBuffer(MAX_COMMAND_OUTPUT);
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      callback();
    };
    const cancel = () => {
      if (child.pid) stopProcessTree(child.pid);
      else child.kill();
      finish(() => reject(signal?.reason ?? new Error("Benchmark preparation was cancelled")));
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout.append(chunk); });
    child.stderr?.on("data", (chunk: string) => { stderr.append(chunk); });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (exitCode) => finish(() => resolveResult({ exitCode, stdout: stdout.text, stderr: stderr.text })));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

async function mustNotExist(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Benchmark destination already exists: ${path}`);
}

function fixturePath(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, path);
  const child = relative(absoluteRoot, absolute);
  if (child === "" || child.startsWith("..")) {
    throw new Error(`Benchmark fixture path escapes its root: ${path}`);
  }
  return absolute;
}

async function checkedGit(args: readonly string[], cwd: string | undefined, signal?: AbortSignal): Promise<string> {
  const result = await run("git", args, cwd, signal);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? "command"} failed: ${result.stderr.trim() || `exit ${result.exitCode ?? "unknown"}`}`);
  }
  return result.stdout;
}

async function applyPatch(path: string, workspacePath: string, signal?: AbortSignal): Promise<void> {
  await readFile(path);
  await checkedGit(["apply", "--check", "--whitespace=error-all", "--", path], workspacePath, signal);
  await checkedGit(["apply", "--whitespace=error-all", "--", path], workspacePath, signal);
}

export interface PrepareBenchmarkFixtureOptions {
  destination: string;
  fixtureRoot: string;
  signal?: AbortSignal;
}

/** Clone a pinned source into a new directory and apply only the reviewed seed patch. */
export async function prepareBenchmarkFixture(
  task: BenchmarkTask,
  options: PrepareBenchmarkFixtureOptions,
): Promise<BenchmarkTask> {
  if (!task.source) throw new Error(`Benchmark ${task.id} does not declare a pinned source`);
  if (!task.fixture) throw new Error(`Benchmark ${task.id} does not declare seed and reference patches`);
  const destination = resolve(options.destination);
  await mustNotExist(destination);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await checkedGit(["clone", "--quiet", "--no-checkout", "--filter=blob:none", "--", task.source.repositoryUrl, destination], undefined, options.signal);
    await checkedGit(["checkout", "--quiet", "--detach", task.source.commit], destination, options.signal);
    const head = (await checkedGit(["rev-parse", "HEAD"], destination, options.signal)).trim().toLowerCase();
    if (!head.startsWith(task.source.commit.toLowerCase())) {
      throw new Error(`Pinned source mismatch for ${task.id}: expected ${task.source.commit}, received ${head}`);
    }
    const preparationSignal = options.signal ?? new AbortController().signal;
    if (task.fixture.setup) {
      const setup = await runBenchmarkVerification(task.fixture.setup, destination, preparationSignal);
      if (!setup.passed) {
        throw new Error(`Benchmark ${task.id} setup failed${setup.error ? `: ${setup.error}` : ` with exit ${setup.exitCode ?? "unknown"}`}`);
      }
    }
    if (task.fixture.pristineVerification) {
      const pristine = await runBenchmarkVerification(task.fixture.pristineVerification, destination, preparationSignal);
      if (!pristine.passed) {
        throw new Error(`Benchmark ${task.id} pinned source did not pass its pristine assertion${pristine.error ? `: ${pristine.error}` : ""}`);
      }
    }
    await applyPatch(fixturePath(options.fixtureRoot, task.fixture.seedPatch), destination, options.signal);
  } catch (error) {
    // The destination was proven absent above and belongs exclusively to this preparation attempt.
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  return { ...task, workspacePath: destination };
}

/** Apply the reviewed repair to an already seeded fixture. */
export async function applyBenchmarkReferenceRepair(
  task: BenchmarkTask,
  fixtureRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!task.fixture) throw new Error(`Benchmark ${task.id} does not declare seed and reference patches`);
  await applyPatch(fixturePath(fixtureRoot, task.fixture.referencePatch), task.workspacePath, signal);
}

export interface BenchmarkFixtureProof {
  seeded: BenchmarkVerificationResult;
  repaired: BenchmarkVerificationResult;
}

/** Prove the seed fails and the reviewed reference patch makes the same assertion pass. */
export async function proveBenchmarkFixture(
  task: BenchmarkTask,
  options: PrepareBenchmarkFixtureOptions,
): Promise<BenchmarkFixtureProof> {
  const verification = task.acceptance ?? task.verification;
  if (!verification) throw new Error(`Benchmark ${task.id} does not declare verification`);
  const prepared = await prepareBenchmarkFixture(task, options);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const seeded = await runBenchmarkVerification(verification, prepared.workspacePath, controller.signal);
    if (seeded.timedOut || seeded.error || seeded.exitCode === null) {
      throw new Error(`Benchmark ${task.id} seed proof failed because verification infrastructure was unavailable: ${seeded.error ?? "no exit code"}`);
    }
    if (seeded.passed) throw new Error(`Benchmark ${task.id} seed did not fail its acceptance assertion`);
    await applyBenchmarkReferenceRepair(prepared, options.fixtureRoot, controller.signal);
    const repaired = await runBenchmarkVerification(verification, prepared.workspacePath, controller.signal);
    if (!repaired.passed) throw new Error(`Benchmark ${task.id} reference repair did not pass its acceptance assertion${repaired.error ? `: ${repaired.error}` : ""}`);
    return { seeded, repaired };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

export interface IsolatedPreparerOptions {
  fixtureRoot: string;
  runsRoot: string;
  campaignId?: string;
  harnessName?: string;
  signal?: AbortSignal;
}

/** Build a suite hook which gives every repetition a fresh pinned workspace. */
export function createIsolatedBenchmarkPreparer(options: IsolatedPreparerOptions) {
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]/gu, "-");
  return (task: BenchmarkTask, repetition: number): Promise<BenchmarkTask> => prepareBenchmarkFixture(task, {
    fixtureRoot: options.fixtureRoot,
    destination: options.campaignId && options.harnessName
      ? resolve(options.runsRoot, safe(options.campaignId), safe(options.harnessName), safe(task.id), String(repetition))
      : resolve(options.runsRoot, `${task.id}-${repetition}`),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
