import { stripVTControlCharacters } from "node:util";
import { redactSecretsPreservingLayout } from "../util/redact-secrets.js";
import type { WorkflowPhase, WorkflowResultClassification } from "../workflow/types.js";
import { EXEC_OUTPUT_BUFFER_BYTES, ExecOutputError, outputChunks } from "./exec-writer.js";

export const EXEC_JSONL_SCHEMA_VERSION = 1 as const;

const MAX_IDENTIFIER_BYTES = 4 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;
const MAX_CHANGED_PATHS = 1_000;
const TRUNCATED_SUFFIX = "\n[truncated]";
export const EXEC_JSONL_EVENT_MAX_BYTES = 64 * 1024;

export interface ExecSessionStartedEvent {
  type: "session_started";
  sessionId: string;
  modelId: string;
  modelName?: string;
  workspacePath: string;
  parentSessionId?: string;
}

export interface ExecAssistantMessageEvent {
  type: "assistant_message";
  text: string;
}

export interface ExecToolStartedEvent {
  type: "tool_started";
  name: string;
  callId?: string;
}

export interface ExecToolFinishedEvent {
  type: "tool_finished";
  name: string;
  callId?: string;
  status?: "completed" | "failed" | "cancelled" | "skipped";
  /** A bounded, redacted display summary. Never pass a raw provider response. */
  output?: string;
}

export interface ExecWorkflowUpdatedEvent {
  type: "workflow_updated";
  phase: WorkflowPhase;
  taskId?: string;
  result?: WorkflowResultClassification;
  resultReason?: string;
  changedPaths?: readonly string[];
  repairAttempts?: number;
  maxRepairAttempts?: number;
  pendingVerification?: boolean;
}

export interface ExecInteractionRequiredEvent {
  type: "interaction_required";
  kind: "approval" | "question";
  tool?: string;
  callId?: string;
  prompt?: string;
}

export type ExecProgressEvent =
  | ExecSessionStartedEvent
  | ExecAssistantMessageEvent
  | ExecToolStartedEvent
  | ExecToolFinishedEvent
  | ExecWorkflowUpdatedEvent
  | ExecInteractionRequiredEvent;

export interface ExecJsonlUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface ExecRunFinishedEvent {
  type: "run_finished";
  /** Absent only when startup failed before a Session could be created. */
  sessionId?: string;
  status:
    | "success"
    | "runtime_error"
    | "configuration_error"
    | "verification_failed"
    | "limit_reached"
    | "interaction_required"
    | "cancelled";
  usageComplete: boolean;
  stopReason?: string;
  workflowResult?: WorkflowResultClassification;
  usage?: ExecJsonlUsage;
}

export type ExecJsonlEvent = ExecProgressEvent | ExecRunFinishedEvent;

export interface ExecJsonlEmitterOptions {
  write(chunk: string, signal?: AbortSignal): void | Promise<void>;
  now?: () => Date;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative safe integer");
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffixBytes = Buffer.byteLength(TRUNCATED_SUFFIX, "utf8");
  if (suffixBytes > maxBytes) {
    let suffix = "";
    let suffixSize = 0;
    for (const character of TRUNCATED_SUFFIX) {
      const characterBytes = Buffer.byteLength(character, "utf8");
      if (suffixSize + characterBytes > maxBytes) break;
      suffix += character;
      suffixSize += characterBytes;
    }
    return suffix;
  }
  const bodyLimit = Math.max(0, maxBytes - suffixBytes);
  let result = "";
  let size = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (size + characterBytes > bodyLimit) break;
    result += character;
    size += characterBytes;
  }
  return `${result}${TRUNCATED_SUFFIX}`;
}

/** Remove terminal controls and credentials before writing any public exec output. */
export function sanitizeExecOutput(value: string, maxBytes = MAX_MESSAGE_BYTES): string {
  return truncateUtf8(redactSecretsPreservingLayout(stripVTControlCharacters(value)), maxBytes);
}

function optionalCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function serializeUsage(usage: ExecJsonlUsage | undefined): Record<string, number> | undefined {
  if (usage === undefined) return undefined;
  const inputTokens = optionalCount(usage.inputTokens);
  const outputTokens = optionalCount(usage.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const reasoningTokens = optionalCount(usage.reasoningTokens);
  const cachedInputTokens = optionalCount(usage.cachedInputTokens);
  const cacheWriteInputTokens = optionalCount(usage.cacheWriteInputTokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(reasoningTokens === undefined ? {} : { reasoning_tokens: reasoningTokens }),
    ...(cachedInputTokens === undefined ? {} : { cached_input_tokens: cachedInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cache_write_input_tokens: cacheWriteInputTokens }),
  };
}

interface PayloadTruncation {
  truncated: boolean;
  displayTextBytes: Map<string, number>;
}

function payload(event: ExecJsonlEvent, truncation: PayloadTruncation): Record<string, unknown> {
  const clipped = (value: string, maximum = MAX_MESSAGE_BYTES, displayField?: string) => {
    const safe = sanitizeExecOutput(value, Number.MAX_SAFE_INTEGER);
    const totalBytes = Buffer.byteLength(safe);
    if (displayField !== undefined) truncation.displayTextBytes.set(displayField, totalBytes);
    if (totalBytes > maximum) truncation.truncated = true;
    return truncateUtf8(safe, maximum);
  };
  const identifier = (value: string) => clipped(value, MAX_IDENTIFIER_BYTES);
  switch (event.type) {
    case "session_started":
      return {
        session_id: identifier(event.sessionId),
        model_id: identifier(event.modelId),
        ...(event.modelName === undefined ? {} : { model_name: identifier(event.modelName) }),
        workspace: identifier(event.workspacePath),
        ...(event.parentSessionId === undefined ? {} : { parent_session_id: identifier(event.parentSessionId) }),
      };
    case "assistant_message":
      return { text: sanitizeExecOutput(event.text, Number.MAX_SAFE_INTEGER) };
    case "tool_started":
      return {
        name: identifier(event.name),
        ...(event.callId === undefined ? {} : { call_id: identifier(event.callId) }),
      };
    case "tool_finished":
      return {
        name: identifier(event.name),
        ...(event.callId === undefined ? {} : { call_id: identifier(event.callId) }),
        ...(event.status === undefined ? {} : { status: event.status }),
        ...(event.output === undefined ? {} : { output: clipped(event.output, MAX_TOOL_OUTPUT_BYTES, "output") }),
      };
    case "workflow_updated": {
      const repairAttempts = optionalCount(event.repairAttempts);
      const maxRepairAttempts = optionalCount(event.maxRepairAttempts);
      const changedPaths: string[] = [];
      let pathBytes = 0;
      for (const path of event.changedPaths ?? []) {
        const safe = identifier(path);
        pathBytes += Buffer.byteLength(JSON.stringify(safe)) + 1;
        if (changedPaths.length >= MAX_CHANGED_PATHS || pathBytes > 48 * 1024) { truncation.truncated = true; break; }
        changedPaths.push(safe);
      }
      return {
        phase: event.phase,
        ...(event.taskId === undefined ? {} : { task_id: identifier(event.taskId) }),
        ...(event.result === undefined ? {} : { result: event.result }),
        ...(event.resultReason === undefined ? {} : { result_reason: clipped(event.resultReason, MAX_MESSAGE_BYTES, "result_reason") }),
        ...(event.changedPaths === undefined
          ? {}
          : { changed_paths: changedPaths, changed_paths_total: event.changedPaths.length, changed_paths_returned: changedPaths.length }),
        ...(repairAttempts === undefined ? {} : { repair_attempts: repairAttempts }),
        ...(maxRepairAttempts === undefined ? {} : { max_repair_attempts: maxRepairAttempts }),
        ...(event.pendingVerification === undefined ? {} : { pending_verification: event.pendingVerification }),
      };
    }
    case "interaction_required":
      return {
        kind: event.kind,
        ...(event.tool === undefined ? {} : { tool: identifier(event.tool) }),
        ...(event.callId === undefined ? {} : { call_id: identifier(event.callId) }),
        ...(event.prompt === undefined ? {} : { prompt: clipped(event.prompt, MAX_MESSAGE_BYTES, "prompt") }),
      };
    case "run_finished": {
      const usage = serializeUsage(event.usage);
      return {
        ...(event.sessionId === undefined ? {} : { session_id: identifier(event.sessionId) }),
        status: event.status,
        usage_complete: event.usageComplete,
        ...(event.stopReason === undefined ? {} : { stop_reason: identifier(event.stopReason) }),
        ...(event.workflowResult === undefined ? {} : { workflow_result: event.workflowResult }),
        ...(usage === undefined ? {} : { usage }),
      };
    }
  }
}

export function serializeExecJsonlEvent(event: ExecJsonlEvent, timestamp = new Date()): string {
  const truncation: PayloadTruncation = { truncated: false, displayTextBytes: new Map() };
  const fields = payload(event, truncation);
  const record: Record<string, unknown> = {
    schema_version: EXEC_JSONL_SCHEMA_VERSION,
    type: event.type,
    timestamp: timestamp.toISOString(),
    ...fields,
    ...(truncation.truncated ? { truncated: true } : {}),
  };
  for (const [field, totalBytes] of truncation.displayTextBytes) {
    if (Buffer.byteLength(String(record[field])) < totalBytes) record[`${field}_total_bytes`] = totalBytes;
  }
  let serialized = JSON.stringify(record);
  if (event.type === "assistant_message") return serialized;
  while (Buffer.byteLength(serialized) + 1 > EXEC_JSONL_EVENT_MAX_BYTES) {
    record.truncated = true;
    // Prefer previews; never omit identity, terminal classifications, usage or truncation metadata.
    const candidates = ["output", "prompt", "result_reason", "changed_paths"]
      .filter((key) => Array.isArray(record[key]) ? record[key].length > 0 : typeof record[key] === "string" && Buffer.byteLength(record[key]) > 64)
      .sort((left, right) => Buffer.byteLength(JSON.stringify(record[right])) - Buffer.byteLength(JSON.stringify(record[left])));
    const candidate = candidates[0] ?? Object.keys(fields)
      .filter((key) => typeof record[key] === "string" && Buffer.byteLength(record[key]) > 64 && !["phase", "status", "result", "workflow_result", "kind"].includes(key))
      .sort((left, right) => Buffer.byteLength(JSON.stringify(record[right])) - Buffer.byteLength(JSON.stringify(record[left])))[0];
    if (!candidate) throw new ExecOutputError("Exec event metadata exceeds the JSONL limit");
    const value = record[candidate];
    if (Array.isArray(value)) {
      const returned = value.slice(0, Math.floor(value.length / 2));
      record[candidate] = returned;
      record.changed_paths_returned = returned.length;
    } else if (typeof value === "string") {
      const totalBytes = truncation.displayTextBytes.get(candidate);
      if (totalBytes !== undefined) record[`${candidate}_total_bytes`] = totalBytes;
      record[candidate] = truncateUtf8(value, Math.floor(Buffer.byteLength(value) / 2));
    }
    serialized = JSON.stringify(record);
  }
  return serialized;
}

/** Writes allowlisted JSONL fields and guarantees that the final event is emitted at most once. */
export class ExecJsonlEmitter {
  readonly #write: ExecJsonlEmitterOptions["write"];
  readonly #now: () => Date;
  #finished = false;
  #broken = false;
  #active = false;
  readonly #waiters: Array<() => void> = [];

  constructor(options: ExecJsonlEmitterOptions) {
    this.#write = options.write;
    this.#now = options.now ?? (() => new Date());
  }

  get finished(): boolean {
    return this.#finished;
  }

  get broken(): boolean { return this.#broken; }

  async #frame(event: ExecJsonlEvent, signal?: AbortSignal): Promise<void> {
    // The queue holds only lock waiters. Producers await delivery and retain their own source data.
    if (this.#waiters.length * EXEC_JSONL_EVENT_MAX_BYTES >= EXEC_OUTPUT_BUFFER_BYTES) {
      throw new ExecOutputError("Exec output queue exceeded 1 MiB");
    }
    if (this.#active) await new Promise<void>((resolve) => this.#waiters.push(resolve));
    else this.#active = true;
    let started = false;
    try {
      if (this.#broken) throw new ExecOutputError("Exec JSONL frame was interrupted");
      signal?.throwIfAborted();
      const timestamp = this.#now();
      if (event.type === "assistant_message") {
        const safe = sanitizeExecOutput(event.text, Number.MAX_SAFE_INTEGER);
        const prefix = JSON.stringify({ schema_version: EXEC_JSONL_SCHEMA_VERSION, type: event.type, timestamp: timestamp.toISOString() }).slice(0, -1);
        started = true;
        await this.#write(`${prefix},"text":"`, signal);
        // JSON string escaping is compositional when chunks never split a surrogate pair.
        for (const chunk of outputChunks(safe, 2048)) {
          signal?.throwIfAborted();
          await this.#write(JSON.stringify(chunk).slice(1, -1), signal);
        }
        await this.#write('"}\n', signal);
      } else {
        const line = `${serializeExecJsonlEvent(event, timestamp)}\n`;
        started = true;
        for (const chunk of outputChunks(line)) await this.#write(chunk, signal);
      }
    } catch (error) {
      if (started) this.#broken = true;
      throw error;
    } finally {
      const next = this.#waiters.shift();
      if (next) next();
      else this.#active = false;
    }
  }

  async emit(event: ExecProgressEvent, signal?: AbortSignal): Promise<void> {
    if (this.#finished) throw new Error("Cannot emit exec progress after run_finished");
    await this.#frame(event, signal);
  }

  async finish(event: ExecRunFinishedEvent): Promise<boolean> {
    if (this.#finished) return false;
    this.#finished = true;
    await this.#frame(event);
    return true;
  }
}
