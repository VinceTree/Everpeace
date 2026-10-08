import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { stopProcessTree } from "./process-cancel.js";
import { decodeTextFile } from "./file-version.js";
import { resolveBundledRipgrep, type RipgrepPathResolver } from "./ripgrep.js";
import { invalidToolArgument, POLICY_DENIED_REMEDY, ToolFeedbackError } from "./tool-feedback.js";
import { PROJECT_MAP_TOOL_DEFINITION, runProjectMap } from "./project-map.js";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 1_000;
const MAX_SEARCH_RESULTS = 200;
const DEFAULT_SEARCH_RESULTS = 100;
const MAX_SEARCH_BYTES = 2 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 5_000;
const MAX_RETAINED_SEARCHES = 16;
const MAX_RETAINED_SEARCH_BYTES = 8 * 1024 * 1024;

export const FILE_TOOL_DEFINITIONS = [
  PROJECT_MAP_TOOL_DEFINITION,
  {
    type: "function" as const,
    name: "read_file",
    description: "Read a page of a UTF-8 text file in the current workspace. Returns line bounds, a whole-file SHA-256 version, and a continuation line when more content remains.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path." },
        start_line: { type: ["integer", "null"], minimum: 1, description: "First one-based line; defaults to 1." },
        max_lines: { type: ["integer", "null"], minimum: 1, maximum: MAX_READ_LINES, description: `Maximum lines to return; defaults to ${DEFAULT_READ_LINES}.` },
      },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function" as const,
    name: "list_directory",
    description: "List up to 500 entries in a directory inside the current workspace. Does not recurse.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative path; use . for the workspace directory." } },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function" as const,
    name: "search_files",
    description: "Search UTF-8 workspace files with ripgrep without invoking a shell. Results are bounded and include file, line and column.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: ["string", "null"], description: "Workspace-relative file or directory; defaults to ." },
        regex: { type: ["boolean", "null"], description: "Interpret query as a regular expression; defaults to false." },
        glob: { type: ["string", "null"], description: "Optional ripgrep include glob." },
        max_results: { type: ["integer", "null"], minimum: 1, maximum: MAX_SEARCH_RESULTS },
      },
      required: ["query"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function" as const,
    name: "glob_files",
    description: "List workspace files matching a glob with ripgrep, without invoking a shell.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: ["string", "null"], description: "Workspace-relative directory; defaults to ." },
        max_results: { type: ["integer", "null"], minimum: 1, maximum: MAX_SEARCH_RESULTS },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function" as const,
    name: "read_search_results",
    description: "Read the next retained page from a prior search_files or glob_files result using its opaque continuation reference.",
    parameters: {
      type: "object",
      properties: {
        continuation: { type: "string" },
        max_results: { type: ["integer", "null"], minimum: 1, maximum: MAX_SEARCH_RESULTS },
      },
      required: ["continuation"],
      additionalProperties: false,
    },
    strict: true,
  },
];

type SearchItem = { path: string; line: number; column: number; text: string } | string;
type SearchKind = "matches" | "files";

interface RetainedSearch {
  kind: SearchKind;
  items: SearchItem[];
  incomplete: boolean;
  cursors: Set<string>;
  bytes: number;
}

/** In-memory, bounded continuation state. References intentionally do not survive Session restoration. */
export class FileSearchSession {
  readonly #cursors = new Map<string, { search: RetainedSearch; offset: number }>();
  readonly #searches = new Set<RetainedSearch>();
  #retainedBytes = 0;

  page(kind: SearchKind, items: SearchItem[], maximum: number, incomplete: boolean): { items: SearchItem[]; continuation: string | null; incomplete: boolean } {
    const search: RetainedSearch = { kind, items, incomplete, cursors: new Set(), bytes: Buffer.byteLength(JSON.stringify(items), "utf8") };
    this.#searches.add(search);
    this.#retainedBytes += search.bytes;
    const first = items.slice(0, maximum);
    const continuation = this.#cursor(search, first.length);
    if (continuation === null) this.#delete(search);
    else this.#enforceLimits();
    return { items: first, continuation, incomplete };
  }

  next(reference: string, maximum: number): { kind: SearchKind; items: SearchItem[]; continuation: string | null; incomplete: boolean } {
    const cursor = this.#cursors.get(reference);
    if (!cursor) throw new ToolFeedbackError("SEARCH_CONTINUATION_EXPIRED", "Search continuation is unknown or expired; run the search again", "Run the original search again; continuation references do not survive consumption, eviction, or Session restoration.");
    this.#cursors.delete(reference);
    cursor.search.cursors.delete(reference);
    const items = cursor.search.items.slice(cursor.offset, cursor.offset + maximum);
    const continuation = this.#cursor(cursor.search, cursor.offset + items.length);
    if (continuation === null) this.#delete(cursor.search);
    return { kind: cursor.search.kind, items, continuation, incomplete: cursor.search.incomplete };
  }

  clear(): void {
    this.#cursors.clear();
    this.#searches.clear();
    this.#retainedBytes = 0;
  }

  #cursor(search: RetainedSearch, offset: number): string | null {
    if (offset >= search.items.length) return null;
    const reference = randomUUID();
    search.cursors.add(reference);
    this.#cursors.set(reference, { search, offset });
    return reference;
  }

  #delete(search: RetainedSearch): void {
    for (const cursor of search.cursors) this.#cursors.delete(cursor);
    if (this.#searches.delete(search)) this.#retainedBytes -= search.bytes;
  }

  #enforceLimits(): void {
    while (this.#searches.size > MAX_RETAINED_SEARCHES || this.#retainedBytes > MAX_RETAINED_SEARCH_BYTES) {
      const oldest = this.#searches.values().next().value as RetainedSearch | undefined;
      if (!oldest) break;
      this.#delete(oldest);
    }
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function integer(value: unknown, fallback: number, maximum: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) invalidToolArgument(field, `an integer from 1 to ${maximum}, or null to use the default`);
  return value as number;
}

async function resolveWorkspaceTarget(workspace: string, requestedPath: string, allowMissing = false): Promise<{ root: string; lexical: string; relative: string }> {
  const root = await fs.realpath(workspace);
  const lexical = path.resolve(workspace, requestedPath);
  if (!inside(path.resolve(workspace), lexical)) throw new ToolFeedbackError("POLICY_DENIED", "File access is limited to the current workspace", POLICY_DENIED_REMEDY);
  let target: string;
  try {
    target = await fs.realpath(lexical);
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = await fs.realpath(path.dirname(lexical));
    target = path.join(parent, path.basename(lexical));
  }
  if (!inside(root, target)) throw new ToolFeedbackError("POLICY_DENIED", "File access is limited to the current workspace", POLICY_DENIED_REMEDY);
  const relative = path.relative(root, target);
  if (process.platform === "win32" && relative.includes(":")) throw new Error("Alternate data streams are not supported");
  return { root, lexical: target, relative };
}

async function runRipgrep(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  resolveRipgrep: RipgrepPathResolver = resolveBundledRipgrep,
): Promise<{ lines: string[]; exitCode: number | null; incomplete: boolean }> {
  signal?.throwIfAborted();
  const executable = await resolveRipgrep();
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("Cancelled")); return; }
    const child = spawn(executable, ["--no-config", ...args], { cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const lines: string[] = [];
    let pending = "";
    let retainedBytes = 0;
    let stderr = "";
    let incomplete = false;
    let stoppedByHost = false;
    let settled = false;
    const stop = () => { if (child.pid) stopProcessTree(child.pid); else child.kill(); };
    const abort = () => stop();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { incomplete = true; stoppedByHost = true; stop(); }, SEARCH_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stoppedByHost) return;
      if (retainedBytes + Buffer.byteLength(pending, "utf8") + Buffer.byteLength(chunk, "utf8") > MAX_SEARCH_BYTES) {
        incomplete = true;
        stoppedByHost = true;
        stop();
        return;
      }
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/u, "");
        pending = pending.slice(newline + 1);
        const bytes = Buffer.byteLength(line, "utf8") + 1;
        if (retainedBytes + bytes > MAX_SEARCH_BYTES) {
          incomplete = true;
          stoppedByHost = true;
          stop();
          return;
        }
        retainedBytes += bytes;
        if (line) lines.push(line);
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-32 * 1024); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) { reject(signal.reason ?? new Error("Cancelled")); return; }
      if (!stoppedByHost && pending) {
        const bytes = Buffer.byteLength(pending, "utf8");
        if (retainedBytes + bytes <= MAX_SEARCH_BYTES) lines.push(pending.replace(/\r$/u, ""));
        else incomplete = true;
      }
      if (!stoppedByHost && exitCode !== 0 && exitCode !== 1) { reject(new Error(stderr.trim() || `ripgrep exited with ${exitCode}`)); return; }
      resolve({ lines, exitCode, incomplete });
    });
  });
}

export const fileSearchLimits = {
  maxSearchBytes: MAX_SEARCH_BYTES,
  maxRetainedSearches: MAX_RETAINED_SEARCHES,
  maxRetainedSearchBytes: MAX_RETAINED_SEARCH_BYTES,
} as const;

export async function runFileTool(
  name: string,
  argumentsJson: string,
  workspace: string,
  signal?: AbortSignal,
  searches?: FileSearchSession,
  resolveRipgrep: RipgrepPathResolver = resolveBundledRipgrep,
): Promise<unknown> {
  let args: unknown;
  try { args = JSON.parse(argumentsJson); } catch { invalidToolArgument("arguments", "a valid JSON object"); }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    invalidToolArgument("arguments", "a JSON object");
  }
  const record = args as Record<string, unknown>;
  const definition = FILE_TOOL_DEFINITIONS.find((tool) => tool.name === name);
  if (!definition) throw new ToolFeedbackError("TOOL_UNAVAILABLE", "Unsupported file tool", "Use only tools advertised in the current request.");
  const allowedFields = Object.keys(definition.parameters.properties);
  for (const key of Object.keys(record)) {
    if (!allowedFields.includes(key)) invalidToolArgument(key, `only the supported fields: ${allowedFields.join(", ")}`);
  }
  if (name === "project_map") return runProjectMap(record, workspace, signal, resolveRipgrep);
  const maximum = integer(record.max_results, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS, "max_results");
  const maxLines = integer(record.max_lines, DEFAULT_READ_LINES, MAX_READ_LINES, "max_lines");
  const requestedStartLine = integer(record.start_line, 1, Number.MAX_SAFE_INTEGER, "start_line");
  if (name === "read_search_results") {
    if (typeof record.continuation !== "string" || !record.continuation) invalidToolArgument("continuation", "a non-empty reference returned by the current search");
    if (!searches) throw new ToolFeedbackError("TOOL_UNAVAILABLE", "Search continuations are unavailable in this host", "Run a narrower search that fits in one page.");
    const page = searches.next(record.continuation, maximum);
    return {
      [page.kind]: page.items,
      continuation: page.continuation,
      has_more: page.continuation !== null,
      incomplete: page.incomplete,
      ...(page.incomplete ? { guidance: "The retained search was incomplete; narrow the query if the retained pages do not contain the needed result." } : {}),
    };
  }
  if ((name === "read_file" || name === "list_directory" || record.path !== undefined && record.path !== null) && (typeof record.path !== "string" || !record.path.trim() || record.path.includes("\0"))) invalidToolArgument("path", "a non-empty workspace-relative string without NUL characters");
  if (name === "glob_files" && (typeof record.pattern !== "string" || !record.pattern.trim() || record.pattern.includes("\0"))) invalidToolArgument("pattern", "a non-empty glob string without NUL characters");
  if (name === "search_files") {
    if (typeof record.query !== "string" || !record.query || record.query.includes("\0")) invalidToolArgument("query", "a non-empty search string without NUL characters");
    if (record.glob !== undefined && record.glob !== null && (typeof record.glob !== "string" || !record.glob || record.glob.includes("\0"))) invalidToolArgument("glob", "a non-empty glob string, or null");
    if (record.regex !== undefined && record.regex !== null && typeof record.regex !== "boolean") invalidToolArgument("regex", "a boolean, or null to use fixed-string search");
  }
  const requestedPath = typeof record.path === "string" && record.path.trim() && !record.path.includes("\0") ? record.path : ".";
  const targetInfo = await resolveWorkspaceTarget(workspace, requestedPath, name === "read_file");
  const { root, lexical: target } = targetInfo;
  if (name === "list_directory") {
    const entries: Array<{ name: string; type: string }> = [];
    const directory = await fs.opendir(target);
    let truncated = false;
    for await (const entry of directory) {
      if (entries.length === 500) { truncated = true; break; }
      entries.push({ name: entry.name, type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file" });
    }
    return { path: requestedPath, entries, truncated };
  }
  if (name === "glob_files") {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) throw new Error("glob_files path must be a directory");
    const result = await runRipgrep(["--files", "--hidden", "--glob", record.pattern as string, "--", "."], target, signal, resolveRipgrep);
    const files = result.lines.map((value) => path.relative(root, path.resolve(target, value)).split(path.sep).join("/"));
    const page = searches?.page("files", files, maximum, result.incomplete);
    const first = page?.items ?? files.slice(0, maximum);
    const continuation = page?.continuation ?? null;
    const unavailableRemainder = searches === undefined && files.length > maximum;
    return { path: requestedPath, pattern: record.pattern, files: first, continuation, has_more: continuation !== null, incomplete: result.incomplete || unavailableRemainder, truncated: result.incomplete || unavailableRemainder || continuation !== null };
  }
  if (name === "search_files") {
    const rgArgs = ["--json", "--hidden", "--line-number", "--column", ...(record.regex === true ? [] : ["--fixed-strings"]), ...(typeof record.glob === "string" ? ["--glob", record.glob] : []), "--", record.query as string, targetInfo.relative || "."];
    const result = await runRipgrep(rgArgs, root, signal, resolveRipgrep);
    const matches: Array<{ path: string; line: number; column: number; text: string }> = [];
    for (const line of result.lines) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string }; submatches?: Array<{ start?: number }> } };
        if (event.type !== "match" || typeof event.data?.path?.text !== "string" || typeof event.data.line_number !== "number") continue;
        matches.push({ path: event.data.path.text.split(path.sep).join("/"), line: event.data.line_number, column: (event.data.submatches?.[0]?.start ?? 0) + 1, text: (event.data.lines?.text ?? "").replace(/\r?\n$/u, "") });
      } catch { /* a malformed final JSON record is represented by incomplete */ }
    }
    const page = searches?.page("matches", matches, maximum, result.incomplete);
    const first = page?.items ?? matches.slice(0, maximum);
    const continuation = page?.continuation ?? null;
    const unavailableRemainder = searches === undefined && matches.length > maximum;
    return {
      query: record.query,
      path: requestedPath,
      matches: first,
      continuation,
      has_more: continuation !== null,
      incomplete: result.incomplete || unavailableRemainder,
      truncated: result.incomplete || unavailableRemainder || continuation !== null,
      ...(result.incomplete || unavailableRemainder ? { guidance: "Search stopped at its time or retained-byte limit; narrow the query if retained pages are insufficient." } : {}),
    };
  }
  let stat;
  try { stat = await fs.stat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: requestedPath, exists: false, sha256: null, content: "", start_line: 1, end_line: 0, total_lines: 0, next_line: null };
    throw error;
  }
  if (!stat.isFile()) throw new Error("Only regular text files can be read");
  if (stat.size > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MiB read limit`);
  const flags = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
  const handle = await fs.open(target, flags);
  try {
    const current = await handle.stat();
    if (!current.isFile()) throw new Error("Only regular text files can be read");
    if (current.size > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MiB read limit`);
    const bytes = Buffer.alloc(current.size);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const version = decodeTextFile(bytes.subarray(0, length));
    const content = version.text;
    const lines = content.split("\n");
    const startLine = integer(requestedStartLine, 1, Math.max(1, lines.length + 1), "start_line");
    const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
    const endLine = selected.length === 0 ? startLine - 1 : startLine + selected.length - 1;
    return {
      path: requestedPath,
      exists: true,
      sha256: version.sha256,
      content: selected.join("\n"),
      start_line: startLine,
      end_line: endLine,
      total_lines: lines.length,
      next_line: endLine < lines.length ? endLine + 1 : null,
    };
  } finally {
    await handle.close();
  }
}

export const fileToolLimits = { maxFileBytes: MAX_FILE_BYTES, maxReadLines: MAX_READ_LINES, maxSearchResults: MAX_SEARCH_RESULTS, maxSearchBytes: MAX_SEARCH_BYTES, searchTimeoutMs: SEARCH_TIMEOUT_MS } as const;
