import { mkdir, readFile, rename, open, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RequestAttemptLedger, type RequestAttemptLedgerSnapshot } from "../agent/request-attempt-ledger.js";
import { RequestExecutor } from "../agent/request-executor.js";
import type { AgentResponse, ResponsesClientLike, ResponsesRequestOptions } from "../agent/model-protocol.js";
import { redactSecretsPreservingLayout } from "../util/redact-secrets.js";
import { digest } from "./memory-data.js";
import { setTimeout as delay } from "node:timers/promises";
import { memoryServiceFailure, type MemoryServiceFailure } from "./memory-service-errors.js";
import { ResourceCleanupError } from "../util/resource-cleanup-error.js";
import { PersistenceError } from "../storage/persistence-error.js";

export class EvidenceStorageError extends Error {
  readonly code: string;
  constructor(readonly stage: string, cause: unknown) {
    const raw = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
    const code = typeof raw === "string" && /^E[A-Z0-9_]{1,30}$/u.test(raw) ? raw : "UNKNOWN";
    super(`Evidence storage failed: ${stage}/${code}`); this.name = "EvidenceStorageError"; this.code = code;
  }
}
/** Retry only Windows sharing violations on the same fsynced temporary file. */
export async function replaceEvidenceFile(temporary: string, file: string, options: { windows?: boolean; replace?: typeof rename; wait?: (ms: number) => Promise<unknown> } = {}): Promise<void> {
  const waits = [10, 25, 50, 100, 200];
  for (let attempt = 0; ; attempt++) {
    try { await (options.replace ?? rename)(temporary, file); return; }
    catch (cause) {
      const error = new EvidenceStorageError("rename", cause);
      if (!(options.windows ?? process.platform === "win32") || !["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= waits.length) throw error;
      await (options.wait ?? delay)(waits[attempt]!);
    }
  }
}

export async function readJson<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")) as T; }
export async function optionalJson<T>(file: string): Promise<T | undefined> {
  try { return await readJson<T>(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}
export async function writeJson(file: string, value: unknown, exclusive = false): Promise<void> {
  let stage = "mkdir";
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = exclusive ? file : `${file}.${randomUUID()}.tmp`;
    stage = "open"; const handle = await open(temporary, "wx", 0o600);
    try { stage = "write"; await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); stage = "sync"; await handle.sync(); }
    finally {
      try { await handle.close(); } catch (error) {
        // oxlint-disable-next-line no-unsafe-finally -- Unresolved file ownership must override an earlier write failure.
        throw new EvidenceStorageError("close", error);
      }
    }
    if (!exclusive) await replaceEvidenceFile(temporary, file);
  } catch (error) { throw error instanceof EvidenceStorageError ? error : new EvidenceStorageError(stage, error); }
}
export async function jsonFiles(directory: string): Promise<string[]> {
  try {
    const result: string[] = [];
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name), meta = await lstat(file);
      if (meta.isSymbolicLink()) throw Error("Evidence must not contain links");
      if (meta.isDirectory()) result.push(...await jsonFiles(file)); else if (name.endsWith(".json")) result.push(file);
    }
    return result;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
}
export class EvidenceFailure extends Error {
  constructor(message: string, readonly details?: { stage: string; code: string }) { super(message); this.name = "EvidenceFailure"; }
}
export interface MemoryRequestRecord {
  key: string; phase: string; requestHash: string; state: "reserved" | "pending" | "settled";
  usage: RequestAttemptLedgerSnapshot; openRequests: number; durationMs?: number;
  response?: AgentResponse; failure?: string; failureDetails?: { stage: string; code: string }; serviceFailure?: MemoryServiceFailure; originRoot?: string;
}

export interface MemoryRequestHooks {
  beforeRequest?(signal: AbortSignal): Promise<() => void>;
  onStop?(reason: string): void;
  onSuccess?(): void;
  fatalReason?(): string | undefined;
}
const stopRank = (reason: string) => /cleanup|unresolved/iu.test(reason) ? 5 : /storage|identity|isolation|authentication|balance|unsupported/iu.test(reason) ? 4 : reason === "cancelled" ? 3 : 0;

/** One shared gate includes auxiliaries and graders; stopped admission is sticky. */
export class MemoryRequestGate {
  readonly controller = new AbortController();
  #active = 0; #peak = 0; #waiting: Array<() => void> = [];
  #stopReason: string | undefined;
  serviceFailure: MemoryServiceFailure | undefined;
  storageFailure: { stage: string; code: string } | undefined;
  constructor(readonly directory: string, readonly limit = 2, readonly hooks: MemoryRequestHooks = {}) {}
  get peak(): number { return this.#peak; }
  get stopReason(): string | undefined { return this.hooks.fatalReason?.() ?? this.#stopReason; }
  get serviceStopped(): boolean { return this.#stopReason === "service_error" || this.#stopReason === "usage_unknown"; }
  failStorage(error?: unknown): void {
    if (error instanceof EvidenceStorageError) this.storageFailure ??= { stage: error.stage, code: error.code };
    this.stop("storage_failed");
  }
  stop(reason: string): void {
    const previous = this.#stopReason;
    if (!previous || stopRank(reason) > stopRank(previous)) this.#stopReason = reason;
    // Infrastructure/usage stops deny new admission while in-flight billing settles.
    // Explicit user cancellation also interrupts in-flight work.
    if (reason === "cancelled") this.controller.abort(new Error(reason));
    for (const wake of this.#waiting.splice(0)) wake();
    if (this.#stopReason !== previous) this.hooks.onStop?.(this.#stopReason!);
  }
  async #enter(signal: AbortSignal): Promise<void> {
    if (this.stopReason) throw new EvidenceFailure(this.stopReason);
    while (this.#active >= this.limit) {
      await new Promise<void>(resolve => {
        const wake = () => { signal.removeEventListener("abort", wake); resolve(); };
        this.#waiting.push(wake); signal.addEventListener("abort", wake, { once: true });
      });
      signal.throwIfAborted();
      if (this.stopReason) throw new EvidenceFailure(this.stopReason);
    }
    signal.throwIfAborted(); this.#active++; this.#peak = Math.max(this.#peak, this.#active);
  }
  async validateRecovery(allowClosedUnknown?: (record: MemoryRequestRecord) => Promise<boolean>): Promise<void> {
    for (const file of await jsonFiles(this.directory)) {
      const r = await readJson<MemoryRequestRecord>(file);
      if (r.state !== "settled" || r.openRequests !== 0 || (!r.response && !r.failure)) throw new EvidenceFailure("Unresolved or unknown request; campaign cannot resume");
      if (!r.usage.complete && !await allowClosedUnknown?.(r)) throw new EvidenceFailure("Unresolved or unknown request; campaign cannot resume");
    }
  }
  client(client: ResponsesClientLike, namespace: string, phase: string): ResponsesClientLike {
    let index = 0;
    return { responses: { create: (params, options) => this.request(client, `${namespace}:${index++}`, phase, params, options) } };
  }
  async request(client: ResponsesClientLike, key: string, phase: string, params: Record<string, unknown>, options: ResponsesRequestOptions = {}): Promise<AgentResponse> {
    if (this.stopReason) throw new EvidenceFailure(this.stopReason);
    const file = path.join(this.directory, `${digest(key)}.json`);
    const existing = await optionalJson<MemoryRequestRecord>(file);
    if (existing) {
      if (existing.requestHash !== digest(JSON.stringify(params))) { this.stop("request_identity_changed"); throw new EvidenceFailure("Cached request identity changed"); }
      if (existing.key !== key || existing.state !== "settled" || !existing.usage.complete || existing.openRequests !== 0) { this.stop("usage_unknown"); throw new EvidenceFailure("Unresolved request"); }
      if (!existing.response) throw new Error("Previous request failed; not replayed");
      return existing.response;
    }
    const signal = AbortSignal.any([this.controller.signal, ...(options.signal ? [options.signal] : [])]);
    const releaseAdmission = await this.hooks.beforeRequest?.(signal);
    try { await this.#enter(signal); } catch (error) { releaseAdmission?.(); throw error; }
    const started = performance.now();
    let record: MemoryRequestRecord | undefined;
    const storageFailed = (error?: unknown) => this.failStorage(error);
    class DurableLedger extends RequestAttemptLedger {
      override async flush(): Promise<void> {
        if (!record) throw new EvidenceFailure("Missing request reservation");
        record.usage = this.snapshot(); record.openRequests = this.openRequests;
        record.state = "pending";
        try { await writeJson(file, record); } catch (error) {
          if (error instanceof EvidenceStorageError) record.failureDetails = { stage: error.stage, code: error.code };
          storageFailed(error); throw new EvidenceFailure("Request checkpoint failed", record.failureDetails);
        }
      }
    }
    const ledger = new DurableLedger(), executor = new RequestExecutor(ledger);
    record = { key, phase, requestHash: digest(JSON.stringify(params)), state: "reserved", usage: ledger.snapshot(), openRequests: 0 };
    let reserved = false;
    try {
      await writeJson(file, record, true);
      reserved = true;
      signal.throwIfAborted();
      const response = await executor.execute(phase === "extract" || phase === "merge" ? "memory" : "benchmark", () => client.responses.create(params, { ...options, signal, maxRetries: 0 }), { reservation: 0, signal });
      record.response = { id: response.id, ...(response.status === undefined ? {} : { status: response.status }), output: [], output_text: redactSecretsPreservingLayout(response.output_text), ...(response.usage === undefined ? {} : { usage: response.usage }) };
      if (response.status === "failed") { this.serviceFailure = record.serviceFailure = memoryServiceFailure(response); this.stop("service_error"); }
      else if (ledger.usageComplete && response.status === "completed") this.hooks.onSuccess?.();
      return response;
    } catch (error) {
      record.failure = error instanceof Error ? error.name : "unknown";
      if (error instanceof EvidenceStorageError) { record.failureDetails = { stage: error.stage, code: error.code }; storageFailed(error); }
      else if (error instanceof EvidenceFailure) this.stop("storage_failed");
      else if (error instanceof ResourceCleanupError) this.stop("cleanup_failed");
      else if (error instanceof PersistenceError) this.stop("storage_failed");
      else if (!signal.aborted || !this.hooks.fatalReason?.()) { this.serviceFailure = record.serviceFailure = memoryServiceFailure(error); this.stop("service_error"); }
      throw error;
    } finally {
      try {
        record.state = "settled"; record.usage = ledger.snapshot(); record.openRequests = ledger.openRequests; record.durationMs = performance.now() - started;
        if (reserved) await writeJson(file, record); else this.stop("storage_failed");
        if (!record.usage.complete) this.stop("usage_unknown");
      } catch (error) { storageFailed(error); }
      this.#active--; this.#waiting.shift()?.(); releaseAdmission?.();
    }
  }
}
