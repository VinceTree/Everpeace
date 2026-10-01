import { spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { decodeTextFile } from "./file-version.js";

const MAX_STATUS_BYTES = 2 * 1024 * 1024;
const MAX_STATUS_ENTRIES = 10_000;
const MAX_DETAIL_BYTES = 2 * 1024 * 1024;
const MAX_DETAIL_LINES = 10_000;

export type WorkspaceChangeKind = "staged" | "unstaged" | "untracked";

export interface WorkspaceChangeEntry {
  id: string;
  path: string;
  oldPath?: string;
  kind: WorkspaceChangeKind;
  status: string;
}

export interface WorkspaceChangeIndex {
  workspacePath: string;
  repositoryRoot: string;
  capturedAt: string;
  entries: WorkspaceChangeEntry[];
}

export interface WorkspaceChangeDetail {
  entry: WorkspaceChangeEntry;
  contentKind: "diff" | "text" | "summary";
  text: string;
  truncated: boolean;
  warning?: string;
}

interface CommandOutput {
  bytes: Buffer;
  truncated: boolean;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function git(
  workspacePath: string,
  args: readonly string[],
  options: { maxBytes: number; signal?: AbortSignal; rejectTruncation?: boolean },
): Promise<CommandOutput> {
  options.signal?.throwIfAborted();
  const child = spawn("git", [...args], {
    cwd: workspacePath,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  let retained = 0;
  let truncated = false;
  const abort = () => child.kill();
  options.signal?.addEventListener("abort", abort, { once: true });
  child.stdout.on("data", (chunk: Buffer) => {
    const before = retained;
    if (retained < options.maxBytes) {
      const remaining = options.maxBytes - retained;
      chunks.push(chunk.subarray(0, remaining));
      retained += Math.min(chunk.length, remaining);
    }
    if (before + chunk.length > options.maxBytes) truncated = true;
    if (truncated && options.rejectTruncation) child.kill();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (Buffer.concat(errors).length < 64 * 1024) errors.push(chunk);
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    options.signal?.throwIfAborted();
    if (truncated && options.rejectTruncation) throw new Error("Workspace change list exceeded its 2 MiB safety limit");
    if (code !== 0) {
      const detail = Buffer.concat(errors).toString("utf8").trim();
      throw new Error(detail || `Git exited with code ${code ?? "unknown"}`);
    }
    return { bytes: Buffer.concat(chunks), truncated };
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

function decodePrefix(bytes: Buffer): string {
  for (let trim = 0; trim < 4 && trim <= bytes.length; trim += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - trim));
    } catch {
      // A bounded command result may end inside one UTF-8 sequence.
    }
  }
  return bytes.toString("utf8");
}

function limitLines(value: string): { text: string; truncated: boolean } {
  const lines = value.split("\n");
  if (lines.length <= MAX_DETAIL_LINES) return { text: value, truncated: false };
  return { text: lines.slice(0, MAX_DETAIL_LINES).join("\n"), truncated: true };
}

function normalizeGitPath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function workspaceRelativeGitPath(repositoryRoot: string, workspaceRoot: string, value: string): string | undefined {
  const target = path.resolve(repositoryRoot, value.split("/").join(path.sep));
  if (!inside(workspaceRoot, target)) return undefined;
  return normalizeGitPath(path.relative(workspaceRoot, target));
}

export async function listWorkspaceChanges(
  workspacePath: string,
  signal?: AbortSignal,
): Promise<WorkspaceChangeIndex> {
  const [rootOutput, statusOutput] = await Promise.all([
    git(workspacePath, ["rev-parse", "--show-toplevel"], { maxBytes: 64 * 1024, ...(signal ? { signal } : {}) }),
    git(workspacePath, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none", "--", "."], {
      maxBytes: MAX_STATUS_BYTES,
      rejectTruncation: true,
      ...(signal ? { signal } : {}),
    }),
  ]);
  const root = decodePrefix(rootOutput.bytes).trim();
  const workspaceRoot = await fs.realpath(workspacePath);
  const values = statusOutput.bytes.toString("utf8").split("\0");
  const entries: WorkspaceChangeEntry[] = [];
  for (let index = 0; index < values.length;) {
    const record = values[index++];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") throw new Error("Git returned an unsupported status record");
    const x = record[0]!;
    const y = record[1]!;
    const target = workspaceRelativeGitPath(root, workspaceRoot, normalizeGitPath(record.slice(3)));
    const renamed = x === "R" || x === "C" || y === "R" || y === "C";
    const oldPathValue = renamed ? normalizeGitPath(values[index++] ?? "") : undefined;
    const oldPath = oldPathValue === undefined ? undefined : workspaceRelativeGitPath(root, workspaceRoot, oldPathValue);
    if (target === undefined) continue;
    if (x === "?" && y === "?") {
      entries.push({ id: `untracked:${target}`, path: target, kind: "untracked", status: "??" });
    } else {
      if (x !== " " && x !== "?") entries.push({ id: `staged:${target}:${oldPath ?? ""}`, path: target, ...(oldPath ? { oldPath } : {}), kind: "staged", status: x });
      if (y !== " " && y !== "?") entries.push({ id: `unstaged:${target}:${oldPath ?? ""}`, path: target, ...(oldPath ? { oldPath } : {}), kind: "unstaged", status: y });
    }
    if (entries.length > MAX_STATUS_ENTRIES) throw new Error(`Workspace has more than ${MAX_STATUS_ENTRIES} change entries; narrow the workspace before reviewing`);
  }
  const order: Record<WorkspaceChangeKind, number> = { staged: 0, unstaged: 1, untracked: 2 };
  entries.sort((left, right) => order[left.kind] - order[right.kind] || left.path.localeCompare(right.path));
  return {
    workspacePath,
    repositoryRoot: root,
    capturedAt: new Date().toISOString(),
    entries,
  };
}

async function untrackedDetail(
  workspacePath: string,
  entry: WorkspaceChangeEntry,
  signal?: AbortSignal,
): Promise<WorkspaceChangeDetail> {
  signal?.throwIfAborted();
  if (process.platform === "win32" && entry.path.includes(":")) {
    return { entry, contentKind: "summary", text: "Windows alternate data streams are not previewed.", truncated: false };
  }
  const root = await fs.realpath(workspacePath);
  const lexical = path.resolve(root, entry.path);
  if (!inside(root, lexical)) throw new Error("Changed path escapes the active workspace");
  const stat = await fs.lstat(lexical);
  if (stat.isSymbolicLink()) return { entry, contentKind: "summary", text: "Untracked symbolic link; target contents are not previewed.", truncated: false };
  const resolved = await fs.realpath(lexical);
  if (!inside(root, resolved)) throw new Error("Changed path resolves outside the active workspace");
  if (!stat.isFile()) return { entry, contentKind: "summary", text: `Untracked ${stat.isDirectory() ? "directory" : "non-regular file"}; no text preview.`, truncated: false };
  const handle = await fs.open(resolved, process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(Math.min(stat.size, MAX_DETAIL_BYTES) + (stat.size > MAX_DETAIL_BYTES ? 0 : 0));
    let length = 0;
    while (length < bytes.length) {
      signal?.throwIfAborted();
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    let decoded;
    try {
      decoded = decodeTextFile(bytes.subarray(0, length)).text;
    } catch {
      return { entry, contentKind: "summary", text: `Untracked binary or non-UTF-8 file (${stat.size} bytes); contents are not displayed.`, truncated: stat.size > MAX_DETAIL_BYTES };
    }
    const lineLimited = limitLines(decoded);
    return {
      entry,
      contentKind: "text",
      text: lineLimited.text,
      truncated: stat.size > MAX_DETAIL_BYTES || lineLimited.truncated,
      ...(stat.size > MAX_DETAIL_BYTES ? { warning: "Preview retained only the first 2 MiB." } : {}),
    };
  } finally {
    await handle.close();
  }
}

export async function readWorkspaceChange(
  workspacePath: string,
  entry: WorkspaceChangeEntry,
  signal?: AbortSignal,
): Promise<WorkspaceChangeDetail> {
  signal?.throwIfAborted();
  if (entry.kind === "untracked") return untrackedDetail(workspacePath, entry, signal);
  const workspaceRoot = await fs.realpath(workspacePath);
  for (const changedPath of [entry.path, entry.oldPath].filter((value): value is string => value !== undefined)) {
    if (!inside(workspaceRoot, path.resolve(workspaceRoot, changedPath))) {
      throw new Error("Changed path escapes the active workspace");
    }
  }
  const args = [
    "-c", "core.quotepath=false",
    "diff",
    ...(entry.kind === "staged" ? ["--cached"] : []),
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--color=never",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--",
    ...(entry.oldPath ? [entry.oldPath] : []),
    entry.path,
  ];
  const output = await git(workspacePath, args, { maxBytes: MAX_DETAIL_BYTES, ...(signal ? { signal } : {}) });
  const limited = limitLines(decodePrefix(output.bytes));
  const truncated = output.truncated || limited.truncated;
  const text = limited.text.trimEnd();
  const special = /(?:^|\n)Binary files .+ differ(?:\n|$)/u.test(text)
    ? "Binary file change; contents are not displayed."
    : /(?:^|\n)(?:(?:new file mode|deleted file mode|old mode|new mode) 120000|index [^\n]+ 120000)(?:\n|$)/u.test(text)
      ? "Symbolic link change; the diff shows link targets only."
      : /(?:^|\n)(?:(?:new file mode|deleted file mode|old mode|new mode) 160000|index [^\n]+ 160000)(?:\n|$)|(?:^|\n)[+-]Subproject commit /u.test(text)
        ? "Submodule change; the diff shows recorded commit identifiers only."
        : undefined;
  return {
    entry,
    contentKind: special ? "summary" : text.startsWith("diff --git ") ? "diff" : "summary",
    text: special ? `${special}\n\n${text}` : text || "No textual diff is available. The path may be binary, a submodule, or concurrently changed.",
    truncated,
    ...(truncated ? { warning: "Detail retained only the first 2 MiB or 10,000 lines." } : {}),
  };
}

export const workspaceReviewLimits = {
  maxStatusBytes: MAX_STATUS_BYTES,
  maxStatusEntries: MAX_STATUS_ENTRIES,
  maxDetailBytes: MAX_DETAIL_BYTES,
  maxDetailLines: MAX_DETAIL_LINES,
} as const;
