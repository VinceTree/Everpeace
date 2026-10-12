import { spawn } from "node:child_process";
import type {
  BenchmarkHarnessAdapter,
  BenchmarkHarnessContext,
  BenchmarkHarnessResult,
  BenchmarkTask,
} from "./types.js";
import { BoundedOutputBuffer } from "../tools/command-record.js";
import { observeProcessCompletion } from "../tools/process-completion.js";
import type { CodingTaskRunner } from "../workflow/task-runner.js";

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

export type ProductionBenchmarkTaskRunner = (
  task: BenchmarkTask,
  context: BenchmarkHarnessContext,
) => Promise<BenchmarkHarnessResult | void>;

/** Wrap the same production task runner used by an application host. */
export function createEverpeaceBenchmarkAdapter(runTask: ProductionBenchmarkTaskRunner): BenchmarkHarnessAdapter {
  return { name: "everpeace", managesRepairs: true, settlesOnCancellation: true, run: runTask };
}

export type CodingTaskRunnerFactory = (
  task: BenchmarkTask,
  context: BenchmarkHarnessContext,
) => CodingTaskRunner | Promise<CodingTaskRunner>;

/** Execute the same CodingTaskRunner lifecycle used by the interactive host. */
export function createCodingTaskRunnerBenchmarkAdapter(
  createRunner: CodingTaskRunnerFactory,
  result?: (task: BenchmarkTask, context: BenchmarkHarnessContext) => BenchmarkHarnessResult | Promise<BenchmarkHarnessResult>,
): BenchmarkHarnessAdapter {
  return {
    name: "everpeace",
    managesRepairs: true,
    settlesOnCancellation: true,
    async run(task, context) {
      const runner = await createRunner(task, context);
      const runResult = await runner.run({ text: task.prompt, source: "benchmark", signal: context.signal });
      const additional = await result?.(task, context);
      return {
        ...additional,
        terminalOutcome: runResult.disposition,
        ...(runResult.agentResult.stopReason === undefined ? {} : { stopReason: runResult.agentResult.stopReason }),
        ...(runResult.workflowResult?.state.result === undefined ? {} : { workflowOutcome: runResult.workflowResult.state.result }),
        diagnosticRounds: runResult.diagnosticRounds,
        ...(runResult.firstVerificationSuite === undefined
          ? {}
          : { firstVerificationSuiteStatus: runResult.firstVerificationSuite.status }),
      };
    },
  };
}

export interface ProcessHarnessAdapterOptions {
  name: string;
  command: string;
  prefixArgs?: readonly string[];
  argumentsForTask(task: BenchmarkTask, context: BenchmarkHarnessContext): readonly string[];
  env?: Readonly<Record<string, string>>;
  parseResult?(stdout: string, stderr: string, context: BenchmarkHarnessContext): BenchmarkHarnessResult | Promise<BenchmarkHarnessResult>;
}

/** Run a fixed external harness without interpolating task text into a shell command. */
export function createProcessHarnessAdapter(options: ProcessHarnessAdapterOptions): BenchmarkHarnessAdapter {
  return {
    name: options.name,
    managesRepairs: true,
    settlesOnCancellation: true,
    async run(task, context) {
      const args = [...(options.prefixArgs ?? []), ...options.argumentsForTask(task, context)];
      context.signal.throwIfAborted();
      const child = spawn(options.command, args, {
        cwd: task.workspacePath, env: { ...process.env, ...options.env },
        windowsHide: true, shell: false, detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const owned = observeProcessCompletion(child, { signal: context.signal });
      const stdout = new BoundedOutputBuffer(MAX_PROCESS_OUTPUT_BYTES);
      const stderr = new BoundedOutputBuffer(MAX_PROCESS_OUTPUT_BYTES);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { if (!owned.closed) stdout.append(chunk); });
      child.stderr?.on("data", (chunk: string) => { if (!owned.closed) stderr.append(chunk); });
      const completion = await owned.completion;
      if (completion.cleanupError) throw completion.cleanupError;
      context.signal.throwIfAborted();
      if (completion.error) throw completion.error;
      const result = { stdout: stdout.text, stderr: stderr.text, exitCode: completion.exitCode };
      await context.writeArtifact?.("harness-stdout.txt", result.stdout);
      await context.writeArtifact?.("harness-stderr.txt", result.stderr);
      if (result.exitCode !== 0) throw new Error(`${options.name} exited with ${result.exitCode ?? "no exit code"}: ${result.stderr.trim() || "no error output"}`);
      if (options.parseResult) return options.parseResult(result.stdout, result.stderr, context);
      return { notes: `${options.name} completed; provider usage was not exposed by its stdout.` };
    },
  };
}

export interface DshHeadlessAdapterOptions {
  /** Use an executable file. On Windows, pass node plus the resolved dsh JS entry instead of an npm .cmd shim. */
  command?: string;
  prefixArgs?: readonly string[];
  env?: Readonly<Record<string, string>>;
  parseResult?: ProcessHarnessAdapterOptions["parseResult"];
}

/** Adapter pinned by the caller to the reviewed dsh installation/commit. */
export function createDshHeadlessAdapter(options: DshHeadlessAdapterOptions = {}): BenchmarkHarnessAdapter {
  return createProcessHarnessAdapter({
    name: "dsh-headless",
    command: options.command ?? "dsh",
    ...(options.prefixArgs ? { prefixArgs: options.prefixArgs } : {}),
    ...(options.env ? { env: options.env } : {}),
    argumentsForTask: (task) => ["--profile", "headless", task.prompt],
    ...(options.parseResult ? { parseResult: options.parseResult } : {}),
  });
}
