import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, rm, writeFile, cp } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { BenchmarkTask, BenchmarkVerificationResult } from "./types.js";
import { resolveBenchmarkProcess, runBenchmarkVerification } from "./runner.js";
import { observeProcessCompletion, ProcessCleanupError } from "../tools/process-completion.js";
import { BoundedOutputBuffer } from "../tools/command-record.js";
import { captureFixtureTreeDigest } from "./evaluation-identity.js";
import { BenchmarkPreparationError } from "./preparation-failure.js";

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const MAX_COMMAND_OUTPUT = 256 * 1024;

async function run(command: string, args: readonly string[], cwd: string | undefined, signal?: AbortSignal): Promise<CommandResult> {
  signal?.throwIfAborted();
  const invocation = resolveBenchmarkProcess(command, args);
  const child = spawn(invocation.command, invocation.args, {
    ...(cwd === undefined ? {} : { cwd }), detached: process.platform !== "win32",
    shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const owned = observeProcessCompletion(child, signal ? { signal } : {});
  const stdout = new BoundedOutputBuffer(MAX_COMMAND_OUTPUT);
  const stderr = new BoundedOutputBuffer(MAX_COMMAND_OUTPUT);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { if (!owned.closed) stdout.append(chunk); });
  child.stderr?.on("data", (chunk: string) => { if (!owned.closed) stderr.append(chunk); });
  const result = await owned.completion;
  if (result.cleanupError) throw result.cleanupError;
  signal?.throwIfAborted();
  if (result.error) throw result.error;
  return { exitCode: result.exitCode, stdout: stdout.text, stderr: stderr.text };
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

function bindValue(value: string, workspacePath: string, fixtureRoot: string): string {
  const fixturePrefix = "${FIXTURE_ROOT}/";
  const workspacePrefix = "${WORKSPACE}/";
  if (value.startsWith(fixturePrefix)) return resolve(fixtureRoot, value.slice(fixturePrefix.length));
  if (value.startsWith(workspacePrefix)) return resolve(workspacePath, value.slice(workspacePrefix.length));
  if (value === "${FIXTURE_ROOT}") return resolve(fixtureRoot);
  if (value === "${WORKSPACE}") return resolve(workspacePath);
  return value.replaceAll("${WORKSPACE}", workspacePath).replaceAll("${FIXTURE_ROOT}", resolve(fixtureRoot));
}

function bindVerification(
  value: BenchmarkTask["verification"],
  workspacePath: string,
  fixtureRoot: string,
): BenchmarkTask["verification"] {
  if (!value) return undefined;
  return {
    ...value,
    command: bindValue(value.command, workspacePath, fixtureRoot),
    ...(value.args === undefined ? {} : { args: value.args.map((item) => bindValue(item, workspacePath, fixtureRoot)) }),
    ...(value.cwd === undefined ? {} : { cwd: bindValue(value.cwd, workspacePath, fixtureRoot) }),
    ...(value.env === undefined ? {} : { env: Object.fromEntries(Object.entries(value.env).map(([key, item]) => [key, bindValue(item, workspacePath, fixtureRoot)])) }),
  };
}

function bindTask(task: BenchmarkTask, workspacePath: string, fixtureRoot: string): BenchmarkTask {
  const fixture = task.fixture && {
    ...task.fixture,
    ...(task.fixture.setup === undefined ? {} : { setup: bindVerification(task.fixture.setup, workspacePath, fixtureRoot)! }),
    ...(task.fixture.pristineVerification === undefined ? {} : { pristineVerification: bindVerification(task.fixture.pristineVerification, workspacePath, fixtureRoot)! }),
  };
  const prepared: BenchmarkTask = { ...task, workspacePath };
  if (fixture !== undefined) prepared.fixture = fixture;
  if (task.verification !== undefined) prepared.verification = bindVerification(task.verification, workspacePath, fixtureRoot)!;
  if (task.acceptance !== undefined) prepared.acceptance = bindVerification(task.acceptance, workspacePath, fixtureRoot)!;
  if (task.regression !== undefined) prepared.regression = bindVerification(task.regression, workspacePath, fixtureRoot)!;
  return prepared;
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
  await checkedGit(["apply", "--check", "--unidiff-zero", "--whitespace=error-all", "--", path], workspacePath, signal);
  await checkedGit(["apply", "--unidiff-zero", "--whitespace=error-all", "--", path], workspacePath, signal);
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
    if (task.source.sourceType === "synthetic") {
      const source = fixturePath(options.fixtureRoot, task.source.fixtureDirectory!);
      if (await captureFixtureTreeDigest(source) !== task.source.fixtureDigest) throw new Error(`Frozen synthetic source changed: ${task.id}`);
      await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
      if (await captureFixtureTreeDigest(destination) !== task.source.fixtureDigest) throw new Error(`Synthetic copy identity mismatch: ${task.id}`);
      await checkedGit(["init", "--quiet"], destination, options.signal);
      await checkedGit(['config','core.autocrlf','false'],destination,options.signal);
    } else {
      await checkedGit(["clone", "--quiet", "--no-checkout", "--filter=blob:none", "-c", "core.autocrlf=false", "--", task.source.repositoryUrl, destination], undefined, options.signal);
      await checkedGit(["checkout", "--quiet", "--detach", task.source.commit], destination, options.signal);
      const head = (await checkedGit(["rev-parse", "HEAD"], destination, options.signal)).trim().toLowerCase();
      if (!head.startsWith(task.source.commit.toLowerCase())) throw new Error(`Pinned source mismatch for ${task.id}: expected ${task.source.commit}, received ${head}`);
    }
    const preparedTask = bindTask(task, destination, options.fixtureRoot);
    const preparationSignal = options.signal ?? new AbortController().signal;
    if (task.fixture.dependencyLock) {
      const lockfile = await readFile(fixturePath(options.fixtureRoot, task.fixture.dependencyLock));
      await writeFile(resolve(destination, "package-lock.json"), lockfile, { flag: "wx" });
    }
    if (preparedTask.fixture?.setup) {
      const setup = await runBenchmarkVerification(preparedTask.fixture.setup, destination, preparationSignal);
      if (setup.cleanupFailed) throw new ProcessCleanupError(setup.error);
      if (!setup.passed) {
        const outcome = /ENOENT|MODULE_NOT_FOUND|ERR_UNKNOWN_BUILTIN_MODULE|not found|not recognized|MISSING_TOOLCHAIN/iu.test(`${setup.error ?? ""} ${setup.stderr} ${setup.stdout}`) ? "missing_toolchain" : "preparation_failed";
        throw new BenchmarkPreparationError(outcome, `Benchmark ${task.id} setup failed (${outcome}); inspect isolated preparation evidence`);
      }
    }
    if (preparedTask.fixture?.pristineVerification) {
      const pristine = await runBenchmarkVerification(preparedTask.fixture.pristineVerification, destination, preparationSignal);
      if (pristine.cleanupFailed) throw new ProcessCleanupError(pristine.error);
      if (!pristine.passed) {
        const reason = pristine.error
          ?? (pristine.timedOut ? "Verification timed out" : pristine.cancelled ? "Verification was cancelled" : `exited with ${pristine.exitCode ?? "unknown"}`);
        throw new Error(`Benchmark ${task.id} pinned source did not pass its pristine assertion: ${reason}`);
      }
    }
    if(task.source.sourceType==='synthetic') {
      // A pristine commit makes scope scoring and isolated Git worktrees
      // available without claiming an upstream revision for synthetic input.
      await checkedGit(['-c','core.hooksPath=','add','--all'],destination,options.signal);
      await checkedGit(['-c','core.hooksPath=','-c','user.name=Everpeace Fixture','-c','user.email=fixture@localhost','commit','--quiet','-m','Frozen pristine synthetic fixture'],destination,options.signal);
    }
    await applyPatch(fixturePath(options.fixtureRoot, task.fixture.seedPatch), destination, options.signal);
    return preparedTask;
  } catch (error) {
    if (error instanceof ProcessCleanupError) throw error;
    // The destination was proven absent above and belongs exclusively to this preparation attempt.
    await rm(destination, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    throw error;
  }
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
  const prepared = await prepareBenchmarkFixture(task, options);
  const verification = prepared.acceptance ?? prepared.verification;
  if (!verification) throw new Error(`Benchmark ${task.id} does not declare verification`);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const seeded = await runBenchmarkVerification(verification, prepared.workspacePath, controller.signal);
    if (seeded.cleanupFailed) throw new ProcessCleanupError(seeded.error);
    if (seeded.timedOut || seeded.error || seeded.exitCode === null) {
      throw new Error(`Benchmark ${task.id} seed proof failed because verification infrastructure was unavailable: ${seeded.error ?? "no exit code"}`);
    }
    if (seeded.passed) throw new Error(`Benchmark ${task.id} seed did not fail its acceptance assertion`);
    const failureOutput = `${seeded.stdout}\n${seeded.stderr}`;
    if (/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|spawn .+ ENOENT/u.test(failureOutput)
      || task.fixture?.seedFailureContains?.some((marker) => !failureOutput.includes(marker))) {
      throw new Error(`Benchmark ${task.id} seed did not produce its expected acceptance failure`);
    }
    await applyBenchmarkReferenceRepair(prepared, options.fixtureRoot, controller.signal);
    const repaired = await runBenchmarkVerification(verification, prepared.workspacePath, controller.signal);
    if (repaired.cleanupFailed) throw new ProcessCleanupError(repaired.error);
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
