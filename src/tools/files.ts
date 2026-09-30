import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { stopProcessTree } from "./process-cancel.js";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 1_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_BYTES = 256 * 1024;

export const FILE_TOOL_DEFINITIONS = [
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
];

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function integer(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) throw new Error("Invalid file tool arguments");
  return value as number;
}

async function resolveWorkspaceTarget(workspace: string, requestedPath: string, allowMissing = false): Promise<{ root: string; lexical: string; relative: string }> {
  const root = await fs.realpath(workspace);
  const lexical = path.resolve(workspace, requestedPath);
  if (!inside(path.resolve(workspace), lexical)) throw new Error("File access is limited to the current workspace");
  let target: string;
  try {
    target = await fs.realpath(lexical);
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = await fs.realpath(path.dirname(lexical));
    target = path.join(parent, path.basename(lexical));
  }
  if (!inside(root, target)) throw new Error("File access is limited to the current workspace");
  const relative = path.relative(root, target);
  if (process.platform === "win32" && relative.includes(":")) throw new Error("Alternate data streams are not supported");
  return { root, lexical: target, relative };
}

function runRipgrep(args: string[], cwd: string, signal?: AbortSignal): Promise<{ stdout: string; exitCode: number | null; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("Cancelled")); return; }
    const child = spawn("rg", args, { cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const abort = () => { if (child.pid) stopProcessTree(child.pid); };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length >= MAX_SEARCH_BYTES) { truncated = true; return; }
      const retained = chunk.slice(0, MAX_SEARCH_BYTES - stdout.length);
      stdout += retained;
      if (retained.length !== chunk.length) truncated = true;
    });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-32 * 1024); });
    child.once("error", (error) => { signal?.removeEventListener("abort", abort); reject(error); });
    child.once("close", (exitCode) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) { reject(signal.reason ?? new Error("Cancelled")); return; }
      if (exitCode !== 0 && exitCode !== 1) { reject(new Error(stderr.trim() || `ripgrep exited with ${exitCode}`)); return; }
      resolve({ stdout, exitCode, truncated });
    });
  });
}

export async function runFileTool(name: string, argumentsJson: string, workspace: string, signal?: AbortSignal): Promise<unknown> {
  const args: unknown = JSON.parse(argumentsJson);
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Invalid file tool arguments");
  }
  const record = args as Record<string, unknown>;
  const requestedPath = typeof record.path === "string" && record.path.trim() && !record.path.includes("\0") ? record.path : ".";
  if (!FILE_TOOL_DEFINITIONS.some((tool) => tool.name === name)) throw new Error("Unsupported file tool");
  if ((name === "read_file" || name === "list_directory") && (!("path" in record) || typeof record.path !== "string" || !record.path.trim() || record.path.includes("\0"))) throw new Error("Invalid file tool arguments");
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
    if (typeof record.pattern !== "string" || !record.pattern.trim() || record.pattern.includes("\0")) throw new Error("Invalid file tool arguments");
    const maximum = integer(record.max_results, MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) throw new Error("glob_files path must be a directory");
    const result = await runRipgrep(["--files", "--hidden", "--glob", record.pattern, "--", "."], target, signal);
    const files = result.stdout.split(/\r?\n/u).filter(Boolean).slice(0, maximum).map((value) => path.relative(root, path.resolve(target, value)).split(path.sep).join("/"));
    return { path: requestedPath, pattern: record.pattern, files, truncated: result.truncated || result.stdout.split(/\r?\n/u).filter(Boolean).length > maximum };
  }
  if (name === "search_files") {
    if (typeof record.query !== "string" || !record.query || record.query.includes("\0")) throw new Error("Invalid file tool arguments");
    if (record.glob !== undefined && record.glob !== null && (typeof record.glob !== "string" || !record.glob || record.glob.includes("\0"))) throw new Error("Invalid file tool arguments");
    const maximum = integer(record.max_results, 100, MAX_SEARCH_RESULTS);
    const rgArgs = ["--json", "--hidden", "--line-number", "--column", "--max-count", String(maximum), ...(record.regex === true ? [] : ["--fixed-strings"]), ...(typeof record.glob === "string" ? ["--glob", record.glob] : []), "--", record.query, targetInfo.relative || "."];
    const result = await runRipgrep(rgArgs, root, signal);
    const matches: Array<{ path: string; line: number; column: number; text: string }> = [];
    for (const line of result.stdout.split(/\r?\n/u)) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string }; submatches?: Array<{ start?: number }> } };
        if (event.type !== "match" || typeof event.data?.path?.text !== "string" || typeof event.data.line_number !== "number") continue;
        matches.push({ path: event.data.path.text.split(path.sep).join("/"), line: event.data.line_number, column: (event.data.submatches?.[0]?.start ?? 0) + 1, text: (event.data.lines?.text ?? "").replace(/\r?\n$/u, "") });
        if (matches.length >= maximum) break;
      } catch { /* an incomplete final JSON record is represented by truncated */ }
    }
    return { query: record.query, path: requestedPath, matches, truncated: result.truncated || matches.length >= maximum };
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
    const contentBytes = bytes.subarray(0, length);
    if (contentBytes.includes(0)) throw new Error("Binary files are not supported");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(contentBytes);
    const lines = content.split("\n");
    const startLine = integer(record.start_line, 1, Math.max(1, lines.length + 1));
    const maxLines = integer(record.max_lines, DEFAULT_READ_LINES, MAX_READ_LINES);
    const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
    const endLine = selected.length === 0 ? startLine - 1 : startLine + selected.length - 1;
    return {
      path: requestedPath,
      exists: true,
      sha256: createHash("sha256").update(content).digest("hex"),
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

export const fileToolLimits = { maxFileBytes: MAX_FILE_BYTES, maxReadLines: MAX_READ_LINES, maxSearchResults: MAX_SEARCH_RESULTS } as const;
