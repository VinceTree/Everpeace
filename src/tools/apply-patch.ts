import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isProtectedPatchPath } from "./sandbox-policy.js";

const MAX_OPERATIONS = 20;
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 512 * 1024;

export type ApplyPatchAction = "create" | "update" | "delete";

export interface ApplyPatchOptions {
  /** Set only by the host after the user selected full access; never model arguments. */
  allowProtectedPaths?: boolean;
}

export interface ApplyPatchOperation {
  path: string;
  action: ApplyPatchAction;
  content?: string;
  patch?: string;
  expectedSha256?: string;
}

export interface ApplyPatchFileResult {
  path: string;
  action: ApplyPatchAction;
  status: "applied" | "failed";
  error?: string;
}

export interface ApplyPatchResult {
  status: "applied" | "failed" | "rejected";
  files: ApplyPatchFileResult[];
  diffSummary?: string;
  rolledBack?: boolean;
  rollbackConflicts?: string[];
  rollbackErrors?: string[];
  error?: string;
}

export interface ApplyPatchPreviewFile {
  path: string;
  action: ApplyPatchAction;
  beforeSha256: string | null;
  afterSha256: string | null;
  diff: string;
}

export interface ApplyPatchPreview {
  status: "ready" | "rejected";
  files: ApplyPatchPreviewFile[];
  diff: string;
  error?: string;
}

export const APPLY_PATCH_TOOL_DEFINITION = {
  type: "function",
  name: "apply_patch",
  description: "Apply a bounded, workspace-relative set of file changes atomically. Prefer this for code edits instead of rewriting files through Bash.",
  parameters: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        minItems: 1,
        maxItems: MAX_OPERATIONS,
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path." },
            action: { type: "string", enum: ["create", "update", "delete"] },
            content: { type: ["string", "null"] },
            patch: { type: ["string", "null"], description: "Unified diff hunks for an update." },
            expectedSha256: { type: ["string", "null"], description: "Optional hash of the current file to prevent stale edits." },
          },
          required: ["path", "action"],
          additionalProperties: false,
        },
      },
    },
    required: ["operations"],
    additionalProperties: false,
  },
  strict: true,
} as const;

function parseOperation(value: unknown): ApplyPatchOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Each patch operation must be an object");
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || !record.path.trim() || record.path.includes("\0")) throw new Error("Patch path must be a non-empty workspace-relative string");
  if (record.action !== "create" && record.action !== "update" && record.action !== "delete") throw new Error("Patch action must be create, update, or delete");
  if (record.content !== undefined && record.content !== null && typeof record.content !== "string") throw new Error("Patch content must be a string");
  if (record.patch !== undefined && record.patch !== null && typeof record.patch !== "string") throw new Error("Patch diff must be a string");
  if (record.expectedSha256 !== undefined && record.expectedSha256 !== null && (typeof record.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(record.expectedSha256))) throw new Error("expectedSha256 must be a SHA-256 hex digest");
  return {
    path: record.path,
    action: record.action,
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(typeof record.patch === "string" ? { patch: record.patch } : {}),
    ...(typeof record.expectedSha256 === "string" ? { expectedSha256: record.expectedSha256.toLowerCase() } : {}),
  };
}

export function parseApplyPatchArguments(argumentsJson: string): ApplyPatchOperation[] {
  let value: unknown;
  try { value = JSON.parse(argumentsJson); } catch { throw new Error("Invalid apply_patch JSON arguments"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as Record<string, unknown>).operations)) throw new Error("apply_patch requires an operations array");
  const operations = (value as { operations: unknown[] }).operations;
  if (operations.length === 0 || operations.length > MAX_OPERATIONS) throw new Error(`apply_patch accepts 1-${MAX_OPERATIONS} operations`);
  return operations.map(parseOperation);
}

function applyUnifiedPatch(original: string, patch: string): string {
  const source = original.replace(/\r\n/gu, "\n").split("\n");
  const lines = patch.replace(/\r\n/gu, "\n").split("\n");
  if (!lines.some((line) => line.startsWith("@@ "))) throw new Error("Update patch must contain a unified diff hunk");
  const output: string[] = [];
  let sourceIndex = 0;
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    if (!lines[lineIndex]!.startsWith("@@ ")) { lineIndex++; continue; }
    const hunk = lines[lineIndex]!;
    const index = lineIndex;
    const hunkLines: string[] = [];
    for (let cursor = index + 1; cursor < lines.length && !lines[cursor]!.startsWith("@@ "); cursor++) hunkLines.push(lines[cursor]!);
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(hunk);
    if (!match) throw new Error(`Invalid unified diff hunk: ${hunk}`);
    const oldStart = Number(match[1]) - 1;
    if (oldStart < sourceIndex || oldStart > source.length) throw new Error("Unified diff hunk is out of range");
    output.push(...source.slice(sourceIndex, oldStart));
    sourceIndex = oldStart;
    for (const line of hunkLines) {
      if (line.startsWith("\\ No newline")) continue;
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " ") {
        if (source[sourceIndex] !== text) throw new Error("Unified diff context does not match the current file");
        output.push(source[sourceIndex]!);
        sourceIndex++;
      } else if (marker === "-") {
        if (source[sourceIndex] !== text) throw new Error("Unified diff removal does not match the current file");
        sourceIndex++;
      } else if (marker === "+") {
        output.push(text);
      } else if (line.length > 0) {
        throw new Error("Unified diff contains an invalid hunk line");
      }
    }
    lineIndex = index + 1 + hunkLines.length;
  }
  output.push(...source.slice(sourceIndex));
  return output.join("\n");
}

async function assertSafeTarget(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("Patch path is outside the current workspace");
  const parts = relative ? relative.split(path.sep) : [];
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Patch paths cannot traverse symbolic links");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readTarget(target: string): Promise<{ exists: boolean; content: string }> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Patch target must be a regular file");
    if (stat.size > MAX_FILE_BYTES) throw new Error("Patch target exceeds the 512 KiB limit");
    const handle = await fs.open(target, constants.O_RDONLY);
    try { return { exists: true, content: await handle.readFile("utf8") }; } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, content: "" };
    throw error;
  }
}

async function atomicWrite(target: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("Patched file exceeds the 512 KiB limit");
  const temporary = `${target}.everpeace-${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  try { await fs.rename(temporary, target); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

async function exclusiveCreate(target: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("Patched file exceeds the 512 KiB limit");
  const handle = await fs.open(target, "wx");
  try { await handle.writeFile(content, "utf8"); }
  catch (error) { await handle.close(); await fs.rm(target, { force: true }); throw error; }
  await handle.close();
}

async function sameTargetVersion(target: string, expected: { exists: boolean; content: string }): Promise<boolean> {
  const current = await readTarget(target);
  return current.exists === expected.exists && (!current.exists || digest(current.content) === digest(expected.content));
}

interface PreparedPatch {
  operation: ApplyPatchOperation;
  target: string;
  before: { exists: boolean; content: string };
  after?: string;
}

async function preparePatch(
  operations: readonly ApplyPatchOperation[],
  workspace: string,
  options: ApplyPatchOptions,
): Promise<{ prepared: PreparedPatch[] } | { error: string }> {
  if (operations.length === 0 || operations.length > MAX_OPERATIONS) return { error: `apply_patch accepts 1-${MAX_OPERATIONS} operations` };
  let root: string;
  try {
    root = await fs.realpath(workspace);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const prepared: PreparedPatch[] = [];
  const seen = new Set<string>();
  let patchBytes = 0;
  try {
    for (const operation of operations) {
      patchBytes += Buffer.byteLength(operation.content ?? operation.patch ?? "", "utf8");
      if (patchBytes > MAX_PATCH_BYTES) throw new Error("Patch batch exceeds the 512 KiB limit");
      const target = path.resolve(workspace, operation.path);
      await assertSafeTarget(root, target);
      const relative = path.relative(root, target);
      if (relative.includes(":")) throw new Error("Alternate data streams are not supported");
      if (!options.allowProtectedPaths && isProtectedPatchPath(relative)) throw new Error("Editing protected workspace metadata requires full access");
      const key = path.relative(root, target).toLowerCase();
      if (seen.has(key)) throw new Error(`Duplicate patch path: ${operation.path}`);
      seen.add(key);
      const before = await readTarget(target);
      if (operation.action === "create" && before.exists) throw new Error(`File already exists: ${operation.path}`);
      if (operation.action !== "create" && !before.exists) throw new Error(`File does not exist: ${operation.path}`);
      if (operation.expectedSha256 && (!before.exists || digest(before.content) !== operation.expectedSha256)) throw new Error(`File changed since it was read: ${operation.path}`);
      let after: string | undefined;
      if (operation.action === "create") {
        if (operation.content === undefined || operation.patch !== undefined) throw new Error("Create operations require content only");
        after = operation.content;
      } else if (operation.action === "update") {
        if ((operation.content === undefined) === (operation.patch === undefined)) throw new Error("Update operations require exactly one of content or patch");
        after = operation.patch === undefined ? operation.content : applyUnifiedPatch(before.content, operation.patch);
      }
      if (after !== undefined && Buffer.byteLength(after, "utf8") > MAX_FILE_BYTES) throw new Error("Patched file exceeds the 512 KiB limit");
      prepared.push({ operation, target, before, ...(after === undefined ? {} : { after }) });
    }
    return { prepared };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function diffFor(item: PreparedPatch): string {
  const oldLines = item.before.content.replace(/\r\n/gu, "\n").split("\n");
  const newLines = (item.after ?? "").replace(/\r\n/gu, "\n").split("\n");
  const oldHeader = item.before.exists ? `--- a/${item.operation.path}` : "--- /dev/null";
  const newHeader = item.operation.action === "delete" ? "+++ /dev/null" : `+++ b/${item.operation.path}`;
  const removed = item.before.exists ? oldLines.map((line) => `-${line}`) : [];
  const added = item.operation.action === "delete" ? [] : newLines.map((line) => `+${line}`);
  const oldCount = item.before.exists ? oldLines.length : 0;
  const newCount = item.operation.action === "delete" ? 0 : newLines.length;
  return [oldHeader, newHeader, `@@ -1,${oldCount} +1,${newCount} @@`, ...removed, ...added].join("\n");
}

export async function previewApplyPatch(
  operations: readonly ApplyPatchOperation[],
  workspace: string,
  options: ApplyPatchOptions = {},
): Promise<ApplyPatchPreview> {
  const result = await preparePatch(operations, workspace, options);
  if ("error" in result) return { status: "rejected", files: [], diff: "", error: result.error };
  const files = result.prepared.map((item) => ({
    path: item.operation.path,
    action: item.operation.action,
    beforeSha256: item.before.exists ? digest(item.before.content) : null,
    afterSha256: item.after === undefined ? null : digest(item.after),
    diff: diffFor(item),
  }));
  return { status: "ready", files, diff: files.map((file) => file.diff).join("\n") };
}

export async function runApplyPatch(
  operations: readonly ApplyPatchOperation[],
  workspace: string,
  options: ApplyPatchOptions = {},
): Promise<ApplyPatchResult> {
  const preparedResult = await preparePatch(operations, workspace, options);
  if ("error" in preparedResult) return { status: "rejected", files: [], error: preparedResult.error };
  const prepared = preparedResult.prepared;
  const files: ApplyPatchFileResult[] = [];
  const applied: PreparedPatch[] = [];
  try {
    for (const item of prepared) {
      if (!(await sameTargetVersion(item.target, item.before))) throw new Error(`File changed after the patch was prepared: ${item.operation.path}`);
      if (item.operation.action === "delete") await fs.unlink(item.target);
      else if (item.operation.action === "create") await exclusiveCreate(item.target, item.after!);
      else await atomicWrite(item.target, item.after!);
      applied.push(item);
      files.push({ path: item.operation.path, action: item.operation.action, status: "applied" });
    }
    return {
      status: "applied",
      files,
      diffSummary: prepared.map(({ operation }) => `${operation.action} ${operation.path}`).join("\n"),
    };
  } catch (error) {
    const rollbackConflicts: string[] = [];
    const rollbackErrors: string[] = [];
    for (const item of [...applied].reverse()) {
      try {
        const expectedAfter = { exists: item.after !== undefined, content: item.after ?? "" };
        if (!(await sameTargetVersion(item.target, expectedAfter))) {
          rollbackConflicts.push(item.operation.path);
          continue;
        }
        if (item.before.exists) await atomicWrite(item.target, item.before.content);
        else await fs.rm(item.target, { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(`${item.operation.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    return {
      status: "failed",
      files,
      rolledBack: rollbackConflicts.length === 0 && rollbackErrors.length === 0,
      ...(rollbackConflicts.length > 0 ? { rollbackConflicts } : {}),
      ...(rollbackErrors.length > 0 ? { rollbackErrors } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
