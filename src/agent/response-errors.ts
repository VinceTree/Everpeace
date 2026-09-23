interface ErrorMetadata {
  status?: number;
  name?: string;
  code?: string;
  type?: string;
  param?: string;
  text: string;
}

interface ModelFailure {
  status?: string;
  error?: unknown;
  incomplete_details?: unknown;
}

const CONTEXT_LIMIT_CODES = new Set([
  "context_length_exceeded",
  "context_window_exceeded",
  "max_context_length_exceeded",
  "input_too_long",
  "too_many_input_tokens",
]);

const STREAM_UNSUPPORTED_CODES = new Set([
  "stream_not_supported",
  "streaming_not_supported",
  "unsupported_streaming",
]);

const STREAM_PARAMETER_CODES = new Set([
  "invalid_parameter",
  "not_supported",
  "unsupported_parameter",
]);

const RETRYABLE_RESPONSE_CODES = new Set([
  "connection_error",
  "rate_limit_exceeded",
  "server_error",
  "timeout",
]);

const STREAM_UNSUPPORTED_STATUSES = new Set([400, 404, 405, 415, 422, 501]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function metadata(value: unknown): ErrorMetadata {
  const queue: unknown[] = [value];
  const seen = new Set<unknown>();
  const text: string[] = [];
  let status: number | undefined;
  let name: string | undefined;
  let code: string | undefined;
  let type: string | undefined;
  let param: string | undefined;

  while (queue.length > 0 && seen.size < 12) {
    const current = queue.shift();
    if (current === undefined || current === null || seen.has(current)) continue;
    seen.add(current);
    if (typeof current === "string") {
      text.push(current);
      continue;
    }
    const item = record(current);
    if (!item) continue;
    if (status === undefined && typeof item.status === "number") status = item.status;
    name ??= stringField(item.name);
    code ??= stringField(item.code)?.toLowerCase();
    type ??= stringField(item.type)?.toLowerCase();
    param ??= stringField(item.param)?.toLowerCase();
    for (const key of ["message", "reason"]) {
      const part = stringField(item[key]);
      if (part) text.push(part);
    }
    for (const key of ["error", "cause", "details", "incomplete_details"]) {
      if (item[key] !== undefined) queue.push(item[key]);
    }
  }

  return {
    ...(status === undefined ? {} : { status }),
    ...(name === undefined ? {} : { name }),
    ...(code === undefined ? {} : { code }),
    ...(type === undefined ? {} : { type }),
    ...(param === undefined ? {} : { param }),
    text: text.join(" ").toLowerCase(),
  };
}

export function isContextLimitError(error: unknown): boolean {
  const details = metadata(error);
  if (
    (details.code && CONTEXT_LIMIT_CODES.has(details.code)) ||
    (details.type && CONTEXT_LIMIT_CODES.has(details.type))
  ) return true;
  if (details.status !== 400 && details.status !== 413) return false;
  return [
    /maximum context length/,
    /context length (?:has been )?exceeded/,
    /context window (?:has been )?exceeded/,
    /too many input tokens/,
    /input (?:is )?too long/,
  ].some((pattern) => pattern.test(details.text));
}

export function isStreamUnsupportedError(error: unknown): boolean {
  const details = metadata(error);
  if (
    (details.code && STREAM_UNSUPPORTED_CODES.has(details.code)) ||
    (details.type && STREAM_UNSUPPORTED_CODES.has(details.type))
  ) return true;
  const parameterCode = details.code ?? details.type;
  if (details.param === "stream") {
    if (parameterCode && STREAM_PARAMETER_CODES.has(parameterCode)) return true;
    if (details.status !== undefined && STREAM_UNSUPPORTED_STATUSES.has(details.status) &&
      /invalid|not supported|unsupported|not implemented/.test(details.text)) return true;
  }
  return details.status !== undefined &&
    STREAM_UNSUPPORTED_STATUSES.has(details.status) &&
    /\bstream(?:ing)?\b/.test(details.text) &&
    /not supported|unsupported|not implemented/.test(details.text);
}

export class ResponseStreamIncompleteError extends Error {
  readonly retryable = true;

  constructor(options?: { cause?: unknown }) {
    super("Responses stream ended before response.completed", options);
    this.name = "ResponseStreamIncompleteError";
  }
}

export class ModelResponseError extends Error {
  readonly statusCode: string | undefined;
  readonly code: string | undefined;
  readonly type: string | undefined;
  readonly param: string | undefined;
  readonly retryable: boolean;
  readonly response: ModelFailure;

  constructor(response: ModelFailure) {
    const details = metadata(response);
    const status = response.status ?? "failed";
    super(details.text ? `Model response ${status}: ${details.text}` : `Model response did not complete: ${status}`);
    this.name = "ModelResponseError";
    this.statusCode = response.status;
    this.code = details.code;
    this.type = details.type;
    this.param = details.param;
    this.retryable = details.status === 408 || details.status === 409 || details.status === 429 ||
      (details.status !== undefined && details.status >= 500 && details.status <= 599) ||
      (details.code !== undefined && RETRYABLE_RESPONSE_CODES.has(details.code)) ||
      (details.type !== undefined && RETRYABLE_RESPONSE_CODES.has(details.type));
    this.response = response;
  }
}
