import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BoundedOutputBuffer } from "../tools/command-record.js";
import { stopProcessTree } from "../tools/process-cancel.js";
import type { BenchmarkHarnessAdapter, BenchmarkHarnessResult } from "./types.js";

export const PINNED_DSH_REVISION = "639ed015397290b3745d163aafe02ffee4aa3f84";
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const execFileAsync = promisify(execFile);

export interface InstrumentedDshAdapterOptions {
  name?: string;
  sourceRoot: string;
  entryPath: string;
  dshHome: string;
  profile: string;
  revision: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  reasoning: "high";
  maxOutputTokens: 32_768;
  instrumentationPath?: string;
}

interface DshLedger {
  schemaVersion: 1;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheObservedInputTokens: number;
  complete: boolean;
  configurationErrors: string[];
}

function quoteYaml(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function resolvedInstrumentationPath(options: InstrumentedDshAdapterOptions): string {
  return resolve(options.instrumentationPath
    ?? fileURLToPath(new URL("../../docs/benchmark/dsh-instrumentation/index.mjs", import.meta.url)));
}

function profileFiles(options: InstrumentedDshAdapterOptions): { manifest: string; patch: string } {
  const instrumentationPath = resolvedInstrumentationPath(options);
  return {
    manifest: `${JSON.stringify({
      name: `dsh-profile-${options.profile}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
    }, null, 2)}\n`,
    patch: [
      "- id: agent-default-model",
      "  config:",
      "    provider: deepseek-official",
      "    model: !!js process.env.EVERPEACE_BENCHMARK_MODEL",
      "    reasoningEffort: high",
      "",
      "- id: llm-deepseek",
      "  config:",
      "    apiKeyEnv: DEEPSEEK_API_KEY",
      "    reasoningEffort: high",
      "    maxTokens: 32768",
      "",
      "- id: tool-web",
      "  disabled: true",
      "",
      "- insert:",
      "    - id: everpeace-benchmark-instrumentation",
      `      name: ${quoteYaml(instrumentationPath)}`,
      "",
    ].join("\n"),
  };
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Create the dedicated benchmark profile once, or reject an existing profile whose reviewed files differ. */
export async function ensureDshBenchmarkProfile(options: InstrumentedDshAdapterOptions): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/u.test(options.profile)) throw new Error("The dsh benchmark profile name is invalid");
  if (!(await stat(resolvedInstrumentationPath(options))).isFile()) throw new Error("The dsh instrumentation plugin is not a file");
  const profileDir = join(resolve(options.dshHome), "profiles", options.profile);
  const expected = profileFiles(options);
  const manifestPath = join(profileDir, "package.json");
  const patchPath = join(profileDir, "cordis.patch.yml");
  const [manifest, patch] = await Promise.all([readIfPresent(manifestPath), readIfPresent(patchPath)]);
  if (manifest !== undefined || patch !== undefined) {
    if (manifest !== expected.manifest || patch !== expected.patch) {
      throw new Error(`Existing dsh benchmark profile ${profileDir} does not match the reviewed instrumentation profile`);
    }
    return;
  }
  await mkdir(profileDir, { recursive: true });
  await writeFile(manifestPath, expected.manifest, { encoding: "utf8", flag: "wx" });
  try {
    await writeFile(patchPath, expected.patch, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    await rm(manifestPath, { force: true });
    throw error;
  }
}

async function assertPinnedSource(options: InstrumentedDshAdapterOptions): Promise<void> {
  if (options.revision !== PINNED_DSH_REVISION) {
    throw new Error(`dsh revision must be pinned to ${PINNED_DSH_REVISION}`);
  }
  const sourceRoot = await realpath(resolve(options.sourceRoot));
  const entryPath = await realpath(resolve(options.entryPath));
  const within = relative(sourceRoot, entryPath);
  if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error("dsh entryPath must be inside sourceRoot");
  if (!(await stat(entryPath)).isFile()) throw new Error("dsh entryPath is not a file");
  const { stdout } = await execFileAsync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  const actual = stdout.trim();
  if (actual !== options.revision) throw new Error(`dsh checkout is ${actual || "unknown"}; expected ${options.revision}`);
  const { stdout: statusOutput } = await execFileAsync("git", ["-C", sourceRoot, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });
  if (statusOutput.trim()) throw new Error("dsh checkout contains tracked modifications");
}

function runDsh(
  options: InstrumentedDshAdapterOptions,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const stdout = new BoundedOutputBuffer(MAX_PROCESS_OUTPUT_BYTES);
    const stderr = new BoundedOutputBuffer(MAX_PROCESS_OUTPUT_BYTES);
    const child = spawn(process.execPath, [resolve(options.entryPath), ...args], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let cancellation: unknown;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      callback();
    };
    const cancel = () => {
      cancellation = signal.reason ?? new Error("dsh benchmark run was cancelled");
      if (child.pid) stopProcessTree(child.pid);
      else child.kill();
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: string) => stderr.append(chunk));
    child.once("error", (error) => finish(() => reject(cancellation ?? error)));
    child.once("close", (exitCode) => finish(() => cancellation === undefined
      ? resolvePromise({ stdout: stdout.text, stderr: stderr.text, exitCode })
      : reject(cancellation)));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function parseLedger(text: string): DshLedger {
  const value = JSON.parse(text) as Partial<DshLedger>;
  if (value.schemaVersion !== 1 || !Array.isArray(value.configurationErrors)
    || value.configurationErrors.some((item) => typeof item !== "string")) {
    throw new Error("dsh instrumentation ledger has an unsupported shape");
  }
  return {
    schemaVersion: 1,
    inputTokens: nonNegativeInteger(value.inputTokens, "dsh ledger inputTokens"),
    outputTokens: nonNegativeInteger(value.outputTokens, "dsh ledger outputTokens"),
    reasoningTokens: nonNegativeInteger(value.reasoningTokens, "dsh ledger reasoningTokens"),
    cachedInputTokens: nonNegativeInteger(value.cachedInputTokens, "dsh ledger cachedInputTokens"),
    cacheObservedInputTokens: nonNegativeInteger(value.cacheObservedInputTokens, "dsh ledger cacheObservedInputTokens"),
    complete: value.complete === true,
    configurationErrors: [...value.configurationErrors],
  };
}

function hasFinalEvent(stdout: string): boolean {
  return stdout.split(/\r?\n/u).some((line) => {
    try { return (JSON.parse(line) as { type?: unknown }).type === "final"; }
    catch { return false; }
  });
}

/** Run the reviewed dsh checkout and obtain usage at its actual llm/stream attempt boundary. */
export function createInstrumentedDshAdapter(options: InstrumentedDshAdapterOptions): BenchmarkHarnessAdapter {
  return {
    name: options.name ?? `dsh-${options.revision.slice(0, 8)}`,
    managesRepairs: true,
    settlesOnCancellation: true,
    async run(task, context): Promise<BenchmarkHarnessResult> {
      if (!context.tokenBudgetRemaining || context.tokenBudgetRemaining <= 0) throw new Error("dsh requires a positive remaining task token budget");
      await assertPinnedSource(options);
      await ensureDshBenchmarkProfile(options);
      const runDirectory = await mkdtemp(join(tmpdir(), "everpeace-dsh-benchmark-"));
      const ledgerPath = join(runDirectory, "request-ledger.json");
      try {
        const result = await runDsh(options, ["--profile", options.profile, "--json", task.prompt], task.workspacePath, {
          ...process.env,
          DSH_HOME: resolve(options.dshHome),
          DSH_AGENTS_HOME: join(resolve(options.dshHome), "agents"),
          DSH_TELEMETRY_DISABLED: "1",
          DSH_PERMISSION_MODE: "workspace-write",
          DEEPSEEK_API_KEY: options.apiKey,
          DEEPSEEK_BASE_URL: options.baseUrl,
          EVERPEACE_DSH_LEDGER_PATH: ledgerPath,
          EVERPEACE_DSH_PROVIDER: "deepseek-official",
          EVERPEACE_BENCHMARK_REVISION: options.revision,
          EVERPEACE_BENCHMARK_MODEL: options.model,
          EVERPEACE_BENCHMARK_REASONING: options.reasoning,
          EVERPEACE_BENCHMARK_MAX_OUTPUT_TOKENS: String(options.maxOutputTokens),
          EVERPEACE_BENCHMARK_TOKEN_BUDGET: String(context.tokenBudgetRemaining),
        }, context.signal);
        await context.writeArtifact?.("harness-stdout.txt", result.stdout);
        await context.writeArtifact?.("harness-stderr.txt", result.stderr);
        const ledger = parseLedger(await readFile(ledgerPath, "utf8"));
        const completed = result.exitCode === 0 && hasFinalEvent(result.stdout) && ledger.configurationErrors.length === 0;
        const stopReason = ledger.configurationErrors.length > 0
          ? ledger.configurationErrors.join("; ")
          : !ledger.complete
            ? "dsh request usage is incomplete"
            : completed
              ? undefined
              : `dsh exited with ${result.exitCode ?? "no exit code"}`;
        return {
          terminalOutcome: completed ? "completed" : "stopped",
          ...(stopReason ? { stopReason } : {}),
          usage: {
            inputTokens: ledger.inputTokens,
            outputTokens: ledger.outputTokens,
            reasoningTokens: ledger.reasoningTokens,
            cachedInputTokens: ledger.cachedInputTokens,
            cacheObservedInputTokens: ledger.cacheObservedInputTokens,
            complete: ledger.complete,
          },
          notes: `Pinned dsh ${options.revision.slice(0, 8)} profile ${options.profile}`,
        };
      } finally {
        await rm(runDirectory, { recursive: true, force: true });
      }
    },
  };
}
