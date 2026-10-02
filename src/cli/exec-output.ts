import { stripVTControlCharacters } from "node:util";
import { redactSecretsPreservingLayout } from "../util/redact-secrets.js";
import type { WorkflowPhase, WorkflowResultClassification } from "../workflow/types.js";

export const EXEC_JSONL_SCHEMA_VERSION = 1 as const;

const MAX_IDENTIFIER_BYTES = 4 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;
const MAX_CHANGED_PATHS = 1_000;
const TRUNCATED_SUFFIX = "\n[truncated]";

export interface ExecSessionStartedEvent {
  type: "session_started";
  sessionId: string;
  modelId: string;
  modelName?: string;
  workspacePath: string;
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
  write(line: string): void;
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

function identifier(value: string): string {
  return sanitizeExecOutput(value, MAX_IDENTIFIER_BYTES);
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

function payload(event: ExecJsonlEvent): Record<string, unknown> {
  switch (event.type) {
    case "session_started":
      return {
        session_id: identifier(event.sessionId),
        model_id: identifier(event.modelId),
        ...(event.modelName === undefined ? {} : { model_name: identifier(event.modelName) }),
        workspace: identifier(event.workspacePath),
      };
    case "assistant_message":
      return { text: sanitizeExecOutput(event.text) };
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
        ...(event.output === undefined ? {} : { output: sanitizeExecOutput(event.output, MAX_TOOL_OUTPUT_BYTES) }),
      };
    case "workflow_updated": {
      const repairAttempts = optionalCount(event.repairAttempts);
      const maxRepairAttempts = optionalCount(event.maxRepairAttempts);
      return {
        phase: event.phase,
        ...(event.taskId === undefined ? {} : { task_id: identifier(event.taskId) }),
        ...(event.result === undefined ? {} : { result: event.result }),
        ...(event.resultReason === undefined ? {} : { result_reason: sanitizeExecOutput(event.resultReason) }),
        ...(event.changedPaths === undefined
          ? {}
          : { changed_paths: event.changedPaths.slice(0, MAX_CHANGED_PATHS).map((path) => identifier(path)) }),
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
        ...(event.prompt === undefined ? {} : { prompt: sanitizeExecOutput(event.prompt) }),
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
  return JSON.stringify({
    schema_version: EXEC_JSONL_SCHEMA_VERSION,
    type: event.type,
    timestamp: timestamp.toISOString(),
    ...payload(event),
  });
}

/** Writes allowlisted JSONL fields and guarantees that the final event is emitted at most once. */
export class ExecJsonlEmitter {
  readonly #write: (line: string) => void;
  readonly #now: () => Date;
  #finished = false;

  constructor(options: ExecJsonlEmitterOptions) {
    this.#write = options.write;
    this.#now = options.now ?? (() => new Date());
  }

  get finished(): boolean {
    return this.#finished;
  }

  emit(event: ExecProgressEvent): void {
    if (this.#finished) throw new Error("Cannot emit exec progress after run_finished");
    this.#write(`${serializeExecJsonlEvent(event, this.#now())}\n`);
  }

  finish(event: ExecRunFinishedEvent): boolean {
    if (this.#finished) return false;
    this.#finished = true;
    this.#write(`${serializeExecJsonlEvent(event, this.#now())}\n`);
    return true;
  }
}
