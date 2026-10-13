import { spawnOwned as spawn } from "../tools/owned-process.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { RegisteredModel } from "../storage/model-registry.js";
import { BoundedOutputBuffer } from "../tools/command-record.js";
import { observeProcessCompletion } from "../tools/process-completion.js";
import { modelShellEnvironment } from "../tools/sandbox-policy.js";
import type { BenchmarkHarnessAdapter, BenchmarkHarnessResult } from "./types.js";
import type { TeamOptions } from "../team/types.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const RESULT_MARKER = "EVERPEACE_CHECKOUT_RESULT ";
const PREFLIGHT_MARKER = "EVERPEACE_CHECKOUT_PREFLIGHT ";
const PREFLIGHT_TIMEOUT_MS = 30_000;

export interface BenchmarkCheckoutIdentity {
  revision: string;
  sourceDigest: string;
  buildDigest: string;
  node: string;
  entryPath: string;
}

export interface BenchmarkCheckoutPreflight extends BenchmarkCheckoutIdentity {
  providerBoundaryObserved: true;
  requests: number;
  memberRequests?: number;
  networkCalls: 0;
  processCleanup: "awaited";
  model: string;
  reasoning: "high";
  maxOutputTokens: 32_768;
  usage: NonNullable<BenchmarkHarnessResult["usage"]>;
  terminalOutcome?: BenchmarkHarnessResult["terminalOutcome"];
}

export interface CheckoutBenchmarkAdapterOptions {
  name: string;
  sourceRoot: string;
  entryPath: string;
  revision: string;
  sourceDigest: string;
  buildDigest: string;
  model: RegisteredModel;
  loopStrategy?: import("../agent/tool-feedback-policy.js").LoopStrategy;
  team?: TeamOptions;
  repairStrategy?: "baseline" | "candidate";
  sessionsRoot: string;
  memoryPilot?: { directory: string; enabled: boolean };
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function addHashPart(hash: ReturnType<typeof createHash>, name: string, bytes: Uint8Array): void {
  hash.update(String(Buffer.byteLength(name, "utf8"))).update("\0").update(name).update("\0");
  hash.update(String(bytes.byteLength)).update("\0").update(bytes).update("\0");
}

export async function captureBenchmarkCheckoutIdentity(sourceRoot: string, entryPath: string): Promise<BenchmarkCheckoutIdentity> {
  const root = await realpath(path.resolve(sourceRoot));
  const entry = await realpath(path.resolve(entryPath));
  if (!inside(root, entry) || !(await stat(entry)).isFile()) throw new Error("Benchmark checkout entry must be a file inside sourceRoot");
  const dshLayout = path.relative(root, entry).split(path.sep).join("/") === "apps/cli/lib/bin.js";
  const { stdout: revisionOutput } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  const paths = dshLayout ? ["apps", "packages", "vendor", "native", "package.json", "pnpm-lock.yaml"] : ["src", "native", "scripts/build-file-helper.mjs", "package.json", "pnpm-lock.yaml", "tsconfig.json", "tsconfig.build.json"];
  const gitArgs = dshLayout
    ? ["-C", root, "ls-files", "-z", "--cached", "--", ...paths]
    : ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths];
  const { stdout: trackedOutput } = await execFileAsync("git", gitArgs, { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
  const files = trackedOutput.toString("utf8").split("\0").filter(file => file && (!dshLayout || !file.split("/").includes("node_modules"))).sort();
  const sourceHash = createHash("sha256");
  for (const file of files) {
    try { addHashPart(sourceHash, file, await readFile(path.resolve(root, file))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Sparse or polyglot checkouts may omit a conventional root manifest.
      if (!dshLayout) addHashPart(sourceHash, `deleted:${file}`, Buffer.alloc(0));
    }
  }
  const buildHash = createHash("sha256");
  // An unchanged adapter entry can import changed runtime modules. Bind the
  // complete artifact tree (dist for builds, src for development preflight).
  const relativeEntry = path.relative(root, entry);
  const artifactRoot = relativeEntry.includes(path.sep)
    ? path.join(root, relativeEntry.split(path.sep)[0]!) : entry;
  const hashArtifact = async (target: string): Promise<void> => {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) throw new Error("Benchmark artifact tree must not contain symlinks");
    if (metadata.isDirectory()) {
      for (const name of (await readdir(target)).sort()) {
        if (dshLayout && name === "node_modules") continue;
        await hashArtifact(path.join(target, name));
      }
    } else if (metadata.isFile()) {
      addHashPart(buildHash, path.relative(root, target).split(path.sep).join("/"), await readFile(target));
    } else throw new Error("Benchmark artifact tree must contain ordinary files");
  };
  if (dshLayout) {
    // Generated lib modules are often untracked; include each runtime tree
    // without descending into the dependency installation directories.
    for (const directory of ["apps", "packages", "vendor", "native"]) {
      const target = path.join(root, directory);
      try { await lstat(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      await hashArtifact(target);
    }
  } else await hashArtifact(artifactRoot);
  for (const file of [`native/files/bin/${process.platform}-${process.arch}/everpeace-files.exe`, `native/process/bin/${process.platform}-${process.arch}/everpeace-process.exe`]) {
    try { addHashPart(buildHash, file, await readFile(path.join(root, file))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; addHashPart(buildHash, `missing:${file}`, Buffer.alloc(0)); }
  }
  return {
    revision: revisionOutput.trim(),
    sourceDigest: sourceHash.digest("hex"),
    buildDigest: buildHash.digest("hex"),
    node: process.version,
    entryPath: entry,
  };
}

export async function assertBenchmarkCheckoutIdentity(options: Pick<CheckoutBenchmarkAdapterOptions, "sourceRoot" | "entryPath" | "revision" | "sourceDigest" | "buildDigest">): Promise<BenchmarkCheckoutIdentity> {
  const identity = await captureBenchmarkCheckoutIdentity(options.sourceRoot, options.entryPath);
  if (identity.revision !== options.revision) throw new Error(`Benchmark checkout revision ${identity.revision} does not match ${options.revision}`);
  if (identity.sourceDigest !== options.sourceDigest) {
    throw new Error(`Benchmark checkout source digest changed: expected ${options.sourceDigest}, actual ${identity.sourceDigest}`);
  }
  if (identity.buildDigest !== options.buildDigest) {
    throw new Error(`Benchmark checkout build digest changed: expected ${options.buildDigest}, actual ${identity.buildDigest}`);
  }
  return identity;
}

export function checkoutWorkerPath(): string {
  const extension = fileURLToPath(import.meta.url).endsWith(".ts") ? "ts" : "js";
  return fileURLToPath(new URL(`./checkout-worker.${extension}`, import.meta.url));
}

function preflightNetworkGuardPath(): string {
  return fileURLToPath(new URL("../../docs/benchmark/dsh-instrumentation/preflight-network-guard.mjs", import.meta.url));
}

export async function preflightBenchmarkCheckout(
  options: Pick<CheckoutBenchmarkAdapterOptions, "sourceRoot" | "entryPath" | "revision" | "sourceDigest" | "buildDigest" | "loopStrategy" | "team" | "repairStrategy"> & { modelName?: string; modelBaseUrl?: string; responsesProfile?: import("../providers/capabilities.js").ResponsesProfile },
): Promise<BenchmarkCheckoutPreflight> {
  const identity = await assertBenchmarkCheckoutIdentity(options);
  const stdout = new BoundedOutputBuffer(MAX_OUTPUT_BYTES);
  const stderr = new BoundedOutputBuffer(MAX_OUTPUT_BYTES);
  const root = await mkdtemp(path.join(tmpdir(), "everpeace-checkout-preflight-"));
  try {
    const input = JSON.stringify({
      mode: "preflight",
      ...(options.team ? { team: options.team } : {}),
      ...(options.loopStrategy === undefined ? {} : { loopStrategy: options.loopStrategy }),
      ...(options.repairStrategy === undefined ? {} : { repairStrategy: options.repairStrategy }),
      productionModule: pathToFileURL(identity.entryPath).href,
      task: { id: "checkout-preflight", prompt: "Return a short preflight acknowledgement without using tools.", workspacePath: root },
      tokenBudget: options.team?.enabled !== false && options.team ? 200_000 : 100,
      sessionsRoot: path.join(root, "sessions"),
      model: {
        id: "checkout-preflight", model_name: options.modelName ?? "preflight-model",
        base_url: options.modelBaseUrl ?? "https://api.deepseek.com", api_key: "preflight-dummy",
        ...(options.responsesProfile === undefined ? {} : { responses_profile: options.responsesProfile }),
        request_settings: { reasoningEffort: "high", maxOutputTokens: 32_768 },
      },
    });
    const child = spawn(process.execPath, [...process.execArgv, checkoutWorkerPath()], {
      cwd: options.sourceRoot,
      env: { ...modelShellEnvironment(process.env), EVERPEACE_CHECKOUT_PREFLIGHT: "1",
        NODE_OPTIONS: `--import=${pathToFileURL(preflightNetworkGuardPath()).href}` },
      shell: false, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const owned = observeProcessCompletion(child, { timeoutMs: PREFLIGHT_TIMEOUT_MS });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (!owned.closed) stdout.append(chunk); });
    child.stderr.on("data", (chunk: string) => { if (!owned.closed) stderr.append(chunk); });
    child.stdin.end(input);
    const result = await owned.completion;
    if (result.cleanupError) throw result.cleanupError;
    if (result.error) throw result.error;
    if (result.timedOut) throw new Error(`Checkout preflight exceeded ${PREFLIGHT_TIMEOUT_MS}ms`);
    const exitCode = result.exitCode;
    const line = stdout.text.split(/\r?\n/u).find((value) => value.startsWith(PREFLIGHT_MARKER));
    if (exitCode !== 0 || !line) {
      throw new Error(`Checkout preflight failed: ${stderr.text.trim() || `exit ${exitCode ?? "unknown"}`}`);
    }
    const evidence = JSON.parse(line.slice(PREFLIGHT_MARKER.length)) as Omit<BenchmarkCheckoutPreflight, keyof BenchmarkCheckoutIdentity>;
    const members = options.team?.enabled !== false && options.team ? (options.team.maxAgents ?? 3) - 1 : 0;
    if (evidence.providerBoundaryObserved !== true || (members ? evidence.requests < members + 3 || evidence.memberRequests !== members : evidence.requests !== 1) || evidence.reasoning !== "high" || evidence.maxOutputTokens !== 32_768 || evidence.usage.complete !== true) {
      throw new Error("Checkout preflight returned invalid request-boundary evidence");
    }
    return { ...evidence, ...identity, networkCalls: 0, processCleanup: "awaited" };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function parseWorkerResult(stdout: string): BenchmarkHarnessResult {
  const line = stdout.split(/\r?\n/u).reverse().find((value) => value.startsWith(RESULT_MARKER));
  if (!line) throw new Error("Checkout worker did not emit a benchmark result");
  return JSON.parse(line.slice(RESULT_MARKER.length)) as BenchmarkHarnessResult;
}

/** Run one frozen production checkout through the same fresh Node worker boundary. */
export function createCheckoutBenchmarkAdapter(options: CheckoutBenchmarkAdapterOptions): BenchmarkHarnessAdapter {
  return {
    name: options.name,
    managesRepairs: true,
    settlesOnCancellation: true,
    async run(task, context) {
      const identity = await assertBenchmarkCheckoutIdentity(options);
      const stdout = new BoundedOutputBuffer(MAX_OUTPUT_BYTES);
      const stderr = new BoundedOutputBuffer(MAX_OUTPUT_BYTES);
      context.signal.throwIfAborted();
      const input = JSON.stringify({
        productionModule: pathToFileURL(identity.entryPath).href, task,
        ...(options.team ? { team: options.team } : {}),
        tokenBudget: context.tokenBudgetRemaining, sessionsRoot: options.sessionsRoot,
        ...(options.memoryPilot ? { memoryPilot: options.memoryPilot } : {}),
        ...(options.loopStrategy === undefined ? {} : { loopStrategy: options.loopStrategy }),
        ...(options.repairStrategy === undefined ? {} : { repairStrategy: options.repairStrategy }),
        model: { ...options.model, request_settings: { reasoningEffort: "high", maxOutputTokens: 32_768 } },
      });
      const child = spawn(process.execPath, [...process.execArgv, checkoutWorkerPath()], {
        cwd: task.workspacePath, shell: false, windowsHide: true,
        detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      });
      const protocolController = new AbortController();
      let protocolError: Error | undefined;
      let latestAccounting: Pick<BenchmarkHarnessResult, "usage" | "requestAccounting"> | undefined;
      const owned = observeProcessCompletion(child, { signal: AbortSignal.any([context.signal, protocolController.signal]) });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      let pendingLines = "";
      child.stdout.on("data", (chunk: string) => {
        if (owned.closed) return;
        stdout.append(chunk);
        pendingLines += chunk;
        const lines = pendingLines.split("\n");
        pendingLines = lines.pop()!;
        try {
          if (pendingLines.length > MAX_OUTPUT_BYTES) throw new Error("Oversized worker telemetry line");
          for (const line of lines) {
            if (line.startsWith("EVERPEACE_CHECKOUT_USAGE ")) latestAccounting = JSON.parse(line.slice("EVERPEACE_CHECKOUT_USAGE ".length)) as typeof latestAccounting;
            if (line.startsWith("EVERPEACE_CHECKOUT_EVENT ")) context.onEvent(JSON.parse(line.slice(25)) as import("../agent/agent-loop.js").LoopEvent);
            if (line.startsWith("EVERPEACE_CHECKOUT_PHASE ")) context.onPhase(line.slice(25).trim() as import("../agent/agent-loop.js").LoopPhase);
          }
        } catch {
          protocolError ??= new Error("Checkout worker telemetry failed");
          protocolController.abort(protocolError);
        }
      });
      child.stderr.on("data", (chunk: string) => { if (!owned.closed) stderr.append(chunk); });
      child.stdin.end(input);
      const result = await owned.completion;
      await context.writeArtifact?.("checkout-stdout.txt", stdout.text);
      await context.writeArtifact?.("checkout-stderr.txt", stderr.text);
      const failedResult = (): BenchmarkHarnessResult => ({
          terminalOutcome: "stopped", stopReason: result.cleanupError ? "process_cleanup_failed" : context.signal.aborted ? "checkout_cancelled" : "checkout_worker_failed",
          ...(result.cleanupError ? { cleanupFailed: true } : {}),
          ...(latestAccounting ? { ...latestAccounting, usage: { ...latestAccounting.usage!, complete: false }, ...(latestAccounting.requestAccounting ? { requestAttempts: latestAccounting.requestAccounting.requests } : {}) } : {}),
      });
      if (result.cleanupError || protocolError || context.signal.aborted || result.error || result.exitCode !== 0) return failedResult();
      try {
        return { ...parseWorkerResult(stdout.text), notes: `${options.name} ${identity.revision.slice(0, 8)} source ${identity.sourceDigest.slice(0, 12)} build ${identity.buildDigest.slice(0, 12)}` };
      } catch {
        return failedResult();
      }
    },
  };
}
