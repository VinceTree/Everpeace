import { classifyModelError, type ModelErrorCategory } from "../agent/response-errors.js";

export interface MemoryServiceFailure {
  category: ModelErrorCategory;
  transient: boolean;
  httpStatus?: number;
  code?: string;
  retryAfterSeconds?: number;
}

/** Fixed diagnostic fields only: no provider message, body, URL or credential headers. */
export function memoryServiceFailure(error: unknown): MemoryServiceFailure {
  const category = classifyModelError(error);
  const queue = [error], seen = new Set<unknown>();
  const codes = new Set(["server_error", "rate_limit_exceeded", "timeout", "connection_error", "invalid_request_error", "authentication_error", "insufficient_quota", "context_length_exceeded", "content_filter", "econnreset", "econnrefused", "etimedout", "enotfound", "eai_again", "und_err_connect_timeout", "und_err_socket"]);
  let httpStatus: number | undefined, code: string | undefined, retryAfterSeconds: number | undefined;
  while (queue.length && seen.size < 12) {
    const current = queue.shift(); if (!current || typeof current !== "object" || seen.has(current)) continue; seen.add(current);
    const record = current as Record<string, unknown>;
    if (httpStatus === undefined && typeof record.status === "number" && Number.isInteger(record.status) && record.status >= 400 && record.status <= 599) httpStatus = record.status;
    if (code === undefined && typeof record.code === "string" && codes.has(record.code.toLowerCase())) code = record.code.toLowerCase();
    if (code === undefined && (["TimeoutError", "APIConnectionTimeoutError"].includes(String(record.name)) || Object.getPrototypeOf(current)?.constructor?.name === "APIConnectionTimeoutError")) code = "timeout";
    const headers = record.headers as { get?: (name: string) => string | null; "retry-after"?: unknown } | undefined;
    const after = typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"];
    if (typeof after === "string" && /^\d{1,3}$/u.test(after) && Number(after) <= 900) retryAfterSeconds ??= Number(after);
    for (const name of ["cause", "error", "details"]) if (record[name] !== undefined) queue.push(record[name]);
  }
  const transient = !["authentication", "balance", "unsupported_capability"].includes(category)
    && (httpStatus === undefined || httpStatus >= 500 || [408, 409, 425, 429].includes(httpStatus) || category === "context_limit");
  return { category, transient, ...(httpStatus === undefined ? {} : { httpStatus }), ...(code ? { code } : {}), ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) };
}
