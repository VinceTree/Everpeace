import type { BenchmarkTask, BenchmarkTaskSource } from "./types.js";

export interface BenchmarkTaskCatalogEntry extends BenchmarkTask {
  source: BenchmarkTaskSource;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function parseSource(value: unknown): BenchmarkTaskSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Task source must be an object");
  const source = value as Record<string, unknown>;
  const repositoryUrl = nonEmpty(source.repositoryUrl, "source.repositoryUrl");
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    throw new Error("source.repositoryUrl must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("source.repositoryUrl must be an absolute HTTPS URL without credentials or query parameters");
  }
  const commit = nonEmpty(source.commit, "source.commit");
  if (!/^[0-9a-f]{7,64}$/iu.test(commit)) throw new Error("source.commit must be a pinned Git commit SHA");
  const issue = nonEmpty(source.issue, "source.issue");
  const license = source.license === undefined ? undefined : nonEmpty(source.license, "source.license");
  return { repositoryUrl, commit, issue, ...(license === undefined ? {} : { license }) };
}

function parseTask(value: unknown, index: number): BenchmarkTaskCatalogEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Task ${index + 1} must be an object`);
  const raw = value as Record<string, unknown>;
  const id = nonEmpty(raw.id, `tasks[${index}].id`);
  const prompt = nonEmpty(raw.prompt, `tasks[${index}].prompt`);
  const workspacePath = nonEmpty(raw.workspacePath, `tasks[${index}].workspacePath`);
  const source = parseSource(raw.source);
  if (raw.tags !== undefined && (!Array.isArray(raw.tags) || raw.tags.some((tag) => typeof tag !== "string" || tag.trim() === ""))) {
    throw new Error(`tasks[${index}].tags must be an array of non-empty strings`);
  }
  const timeoutValue = raw.timeoutMs;
  const timeoutMs = timeoutValue === undefined ? undefined : typeof timeoutValue === "number" ? timeoutValue : null;
  if (timeoutMs === null || (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0))) throw new Error(`tasks[${index}].timeoutMs must be a positive integer`);
  const repairValue = raw.maxRepairAttempts;
  const maxRepairAttempts = repairValue === undefined ? undefined : typeof repairValue === "number" ? repairValue : null;
  if (maxRepairAttempts === null || (maxRepairAttempts !== undefined && (!Number.isSafeInteger(maxRepairAttempts) || maxRepairAttempts < 0 || maxRepairAttempts > 10))) {
    throw new Error(`tasks[${index}].maxRepairAttempts must be an integer from 0 to 10`);
  }
  const verification = raw.verification;
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) throw new Error(`tasks[${index}].verification is required`);
  const verificationRecord = verification as Record<string, unknown>;
  const command = nonEmpty(verificationRecord.command, `tasks[${index}].verification.command`);
  const args = verificationRecord.args === undefined ? undefined : verificationRecord.args;
  if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))) {
    throw new Error(`tasks[${index}].verification.args must be an array of strings`);
  }
  const expectedExitCode = verificationRecord.expectedExitCode;
  if (expectedExitCode !== undefined && (typeof expectedExitCode !== "number" || !Number.isInteger(expectedExitCode))) {
    throw new Error(`tasks[${index}].verification.expectedExitCode must be an integer`);
  }
  const verificationTimeoutMs = verificationRecord.timeoutMs;
  if (verificationTimeoutMs !== undefined && (typeof verificationTimeoutMs !== "number" || !Number.isSafeInteger(verificationTimeoutMs) || verificationTimeoutMs <= 0)) {
    throw new Error(`tasks[${index}].verification.timeoutMs must be a positive integer`);
  }
  if (verificationRecord.cwd !== undefined && typeof verificationRecord.cwd !== "string") {
    throw new Error(`tasks[${index}].verification.cwd must be a string`);
  }
  return {
    id,
    prompt,
    workspacePath,
    source,
    ...(raw.tags === undefined ? {} : { tags: (raw.tags as string[]).map((tag) => tag.trim()) }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxRepairAttempts === undefined ? {} : { maxRepairAttempts }),
    verification: {
      command,
      ...(args === undefined ? {} : { args: args as string[] }),
      ...(typeof verificationRecord.cwd === "string" ? { cwd: verificationRecord.cwd } : {}),
      ...(expectedExitCode === undefined ? {} : { expectedExitCode }),
      ...(verificationTimeoutMs === undefined ? {} : { timeoutMs: verificationTimeoutMs }),
    },
  };
}

/** Parse a reviewed public-issue catalog without executing preparation or verification commands. */
export function parseBenchmarkTaskCatalog(text: string): BenchmarkTaskCatalogEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Benchmark task catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const values = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray((parsed as Record<string, unknown>).tasks)
      ? (parsed as { tasks: unknown[] }).tasks
      : undefined;
  if (values === undefined) throw new Error("Benchmark task catalog must be an array or an object with a tasks array");
  const seen = new Set<string>();
  return values.map((value, index) => {
    const task = parseTask(value, index);
    if (seen.has(task.id)) throw new Error(`Duplicate benchmark task id: ${task.id}`);
    seen.add(task.id);
    return task;
  });
}
