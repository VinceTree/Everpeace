import type { BenchmarkTask, BenchmarkTaskSource, BenchmarkVerification } from "./types.js";

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

function parseVerification(value: unknown, field: string): BenchmarkVerification {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const record = value as Record<string, unknown>;
  const command = nonEmpty(record.command, `${field}.command`);
  const args = record.args;
  if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))) {
    throw new Error(`${field}.args must be an array of strings`);
  }
  if (record.expectedExitCode !== undefined && (typeof record.expectedExitCode !== "number" || !Number.isInteger(record.expectedExitCode))) {
    throw new Error(`${field}.expectedExitCode must be an integer`);
  }
  if (record.timeoutMs !== undefined && (typeof record.timeoutMs !== "number" || !Number.isSafeInteger(record.timeoutMs) || record.timeoutMs <= 0)) {
    throw new Error(`${field}.timeoutMs must be a positive integer`);
  }
  if (record.cwd !== undefined && typeof record.cwd !== "string") throw new Error(`${field}.cwd must be a string`);
  if (record.env !== undefined && (!record.env || typeof record.env !== "object" || Array.isArray(record.env) || Object.values(record.env).some((item) => typeof item !== "string"))) {
    throw new Error(`${field}.env must contain only string values`);
  }
  return {
    command,
    ...(args === undefined ? {} : { args: args as string[] }),
    ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
    ...(typeof record.expectedExitCode === "number" ? { expectedExitCode: record.expectedExitCode } : {}),
    ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
    ...(record.env === undefined ? {} : { env: record.env as Record<string, string> }),
  };
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
  if (raw.verification === undefined) throw new Error(`tasks[${index}].verification is required`);
  const verification = parseVerification(raw.verification, `tasks[${index}].verification`);
  const acceptance = raw.acceptance === undefined ? undefined : parseVerification(raw.acceptance, `tasks[${index}].acceptance`);
  let fixture: BenchmarkTaskCatalogEntry["fixture"];
  if (raw.fixture !== undefined) {
    if (!raw.fixture || typeof raw.fixture !== "object" || Array.isArray(raw.fixture)) {
      throw new Error(`tasks[${index}].fixture must be an object`);
    }
    const fixtureRecord = raw.fixture as Record<string, unknown>;
    const seedPatch = nonEmpty(fixtureRecord.seedPatch, `tasks[${index}].fixture.seedPatch`);
    const referencePatch = nonEmpty(fixtureRecord.referencePatch, `tasks[${index}].fixture.referencePatch`);
    const dependencyLock = fixtureRecord.dependencyLock === undefined
      ? undefined
      : nonEmpty(fixtureRecord.dependencyLock, `tasks[${index}].fixture.dependencyLock`);
    for (const [field, path] of [["seedPatch", seedPatch], ["referencePatch", referencePatch], ...(dependencyLock === undefined ? [] : [["dependencyLock", dependencyLock] as const])] as const) {
      if (path.includes("\\") || path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "")) {
        throw new Error(`tasks[${index}].fixture.${field} must be a normalized relative path`);
      }
    }
    fixture = {
      seedPatch,
      referencePatch,
      ...(fixtureRecord.seedFailureContains === undefined ? {} : {
        seedFailureContains: (() => {
          const markers = fixtureRecord.seedFailureContains;
          if (!Array.isArray(markers) || markers.length === 0) throw new Error(`tasks[${index}].fixture.seedFailureContains must be a nonempty array`);
          return markers.map((marker, markerIndex) => nonEmpty(marker, `tasks[${index}].fixture.seedFailureContains[${markerIndex}]`));
        })(),
      }),
      ...(dependencyLock === undefined ? {} : { dependencyLock }),
      ...(fixtureRecord.setup === undefined ? {} : { setup: parseVerification(fixtureRecord.setup, `tasks[${index}].fixture.setup`) }),
      ...(fixtureRecord.pristineVerification === undefined ? {} : { pristineVerification: parseVerification(fixtureRecord.pristineVerification, `tasks[${index}].fixture.pristineVerification`) }),
    };
  }
  return {
    id,
    prompt,
    workspacePath,
    source,
    ...(raw.tags === undefined ? {} : { tags: (raw.tags as string[]).map((tag) => tag.trim()) }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxRepairAttempts === undefined ? {} : { maxRepairAttempts }),
    ...(fixture === undefined ? {} : { fixture }),
    ...(acceptance === undefined ? {} : { acceptance }),
    verification,
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

/** Refuse a formal campaign until every catalog entry has reproducible seed and repair material. */
export function parseReproducibleBenchmarkTaskCatalog(text: string): BenchmarkTaskCatalogEntry[] {
  const tasks = parseBenchmarkTaskCatalog(text);
  const missing = tasks.filter((task) => !task.fixture?.setup || !task.fixture.pristineVerification || !task.acceptance).map((task) => task.id);
  if (missing.length > 0) {
    throw new Error(`Benchmark catalog is not reproducible; missing fixture setup, pristine proof, or independent acceptance material for: ${missing.join(", ")}`);
  }
  const unlockedNpm = tasks.filter((task) => {
    const setup = task.fixture!.setup!;
    return /(?:^|[\\/])npm(?:\.cmd)?$/iu.test(setup.command) && !setup.args?.includes("ci");
  }).map((task) => task.id);
  if (unlockedNpm.length > 0) {
    throw new Error(`Benchmark catalog is not reproducible; npm setup must use npm ci for: ${unlockedNpm.join(", ")}`);
  }
  return tasks;
}
