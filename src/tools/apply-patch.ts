import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isProtectedPatchPath } from "./sandbox-policy.js";
import { decodeTextFile, encodeTextFile, sha256Bytes, type TextFileVersion } from "./file-version.js";

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
  replace?: {
    oldText: string;
    newText: string;
  };
  expectedSha256?: string;
}

export type ApplyPatchErrorCode =
  | "INVALID_ARGUMENTS"
  | "POLICY_DENIED"
  | "STALE_VERSION"
  | "REPLACEMENT_NOT_FOUND"
  | "REPLACEMENT_AMBIGUOUS"
  | "REPLACEMENT_UNCHANGED"
  | "PATCH_MISMATCH"
  | "PATCH_FAILED";

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
  errorCode?: ApplyPatchErrorCode;
  remedy?: string;
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
  errorCode?: ApplyPatchErrorCode;
  remedy?: string;
}

export class ApplyPatchError extends Error {
  constructor(
    readonly code: ApplyPatchErrorCode,
    message: string,
    readonly remedy?: string,
  ) {
    super(message);
    this.name = "ApplyPatchError";
  }
}

function patchError(code: ApplyPatchErrorCode, message: string, remedy?: string): never {
  throw new ApplyPatchError(code, message, remedy ?? (code === "INVALID_ARGUMENTS" ? `Correct the apply_patch arguments described by this error: ${message}. Use the advertised operations schema before resubmitting.` : undefined));
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
            replace: {
              type: ["object", "null"],
              description: "Exact single-match text replacement for an update.",
              properties: {
                oldText: { type: "string" },
                newText: { type: "string" },
              },
              required: ["oldText", "newText"],
              additionalProperties: false,
            },
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
  if (!value || typeof value !== "object" || Array.isArray(value)) patchError("INVALID_ARGUMENTS", "Each patch operation must be an object");
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || !record.path.trim() || record.path.includes("\0")) patchError("INVALID_ARGUMENTS", "Patch path must be a non-empty workspace-relative string");
  if (record.action !== "create" && record.action !== "update" && record.action !== "delete") patchError("INVALID_ARGUMENTS", "Patch action must be create, update, or delete");
  if (record.content !== undefined && record.content !== null && typeof record.content !== "string") patchError("INVALID_ARGUMENTS", "Patch content must be a string");
  if (record.patch !== undefined && record.patch !== null && typeof record.patch !== "string") patchError("INVALID_ARGUMENTS", "Patch diff must be a string");
  let replace: ApplyPatchOperation["replace"];
  if (record.replace !== undefined && record.replace !== null) {
    if (!record.replace || typeof record.replace !== "object" || Array.isArray(record.replace)) patchError("INVALID_ARGUMENTS", "Patch replace must be an object");
    const replacement = record.replace as Record<string, unknown>;
    if (typeof replacement.oldText !== "string" || !replacement.oldText.length || typeof replacement.newText !== "string") {
      patchError("INVALID_ARGUMENTS", "Patch replace requires non-empty oldText and string newText");
    }
    if (Object.keys(replacement).some((key) => key !== "oldText" && key !== "newText")) patchError("INVALID_ARGUMENTS", "Patch replace contains unsupported fields");
    replace = { oldText: replacement.oldText, newText: replacement.newText };
  }
  if (record.expectedSha256 !== undefined && record.expectedSha256 !== null && (typeof record.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(record.expectedSha256))) patchError("INVALID_ARGUMENTS", "expectedSha256 must be a SHA-256 hex digest");
  if (Object.keys(record).some((key) => !["path", "action", "content", "patch", "replace", "expectedSha256"].includes(key))) patchError("INVALID_ARGUMENTS", "Patch operation contains unsupported fields");
  return {
    path: record.path,
    action: record.action,
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(typeof record.patch === "string" ? { patch: record.patch } : {}),
    ...(replace ? { replace } : {}),
    ...(typeof record.expectedSha256 === "string" ? { expectedSha256: record.expectedSha256.toLowerCase() } : {}),
  };
}

export function parseApplyPatchArguments(argumentsJson: string): ApplyPatchOperation[] {
  let value: unknown;
  try { value = JSON.parse(argumentsJson); } catch { patchError("INVALID_ARGUMENTS", "Invalid apply_patch JSON arguments"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as Record<string, unknown>).operations)) patchError("INVALID_ARGUMENTS", "apply_patch requires an operations array");
  if (Object.keys(value as Record<string, unknown>).some((key) => key !== "operations")) patchError("INVALID_ARGUMENTS", "apply_patch contains unsupported fields");
  const operations = (value as { operations: unknown[] }).operations;
  if (operations.length === 0 || operations.length > MAX_OPERATIONS) patchError("INVALID_ARGUMENTS", `apply_patch accepts 1-${MAX_OPERATIONS} operations`);
  return operations.map(parseOperation);
}

function applyUnifiedPatch(original: string, patch: string): string {
  const source = original.replace(/\r\n/gu, "\n").split("\n");
  const lines = patch.replace(/\r\n/gu, "\n").split("\n");
  if (!lines.some((line) => line.startsWith("@@ "))) patchError("PATCH_MISMATCH", "Update patch must contain a unified diff hunk", "Read the current file and submit corrected hunks.");
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
    if (!match) patchError("PATCH_MISMATCH", `Invalid unified diff hunk: ${hunk}`, "Read the current file and submit corrected hunks.");
    const oldStart = Number(match[1]) - 1;
    if (oldStart < sourceIndex || oldStart > source.length) patchError("PATCH_MISMATCH", "Unified diff hunk is out of range", "Read the current file and submit corrected hunks.");
    output.push(...source.slice(sourceIndex, oldStart));
    sourceIndex = oldStart;
    for (const line of hunkLines) {
      if (line.startsWith("\\ No newline")) continue;
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " ") {
        if (source[sourceIndex] !== text) patchError("PATCH_MISMATCH", "Unified diff context does not match the current file", "Read the current file and submit corrected hunks.");
        output.push(source[sourceIndex]!);
        sourceIndex++;
      } else if (marker === "-") {
        if (source[sourceIndex] !== text) patchError("PATCH_MISMATCH", "Unified diff removal does not match the current file", "Read the current file and submit corrected hunks.");
        sourceIndex++;
      } else if (marker === "+") {
        output.push(text);
      } else if (line.length > 0) {
        patchError("PATCH_MISMATCH", "Unified diff contains an invalid hunk line", "Read the current file and submit corrected hunks.");
      }
    }
    lineIndex = index + 1 + hunkLines.length;
  }
  output.push(...source.slice(sourceIndex));
  return output.join("\n");
}

function applyExactReplacement(original: string, replacement: NonNullable<ApplyPatchOperation["replace"]>): string {
  const source = original.replace(/\r\n/gu, "\n");
  const oldText = replacement.oldText.replace(/\r\n/gu, "\n");
  const newText = replacement.newText.replace(/\r\n/gu, "\n");
  if (!oldText.length) patchError("INVALID_ARGUMENTS", "Replacement oldText must not be empty");
  if (oldText === newText) patchError("REPLACEMENT_UNCHANGED", "Replacement would not change the file", "Submit a replacement whose newText differs from oldText.");
  const first = source.indexOf(oldText);
  if (first < 0) patchError("REPLACEMENT_NOT_FOUND", "Replacement oldText was not found", "Read the current file and copy the exact text to replace.");
  if (source.indexOf(oldText, first + 1) >= 0) patchError("REPLACEMENT_AMBIGUOUS", "Replacement oldText matches more than once", "Include more surrounding text so oldText matches exactly once.");
  return `${source.slice(0, first)}${newText}${source.slice(first + oldText.length)}`;
}

async function assertSafeTarget(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) patchError("POLICY_DENIED", "Patch path is outside the current workspace");
  const parts = relative ? relative.split(path.sep) : [];
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) patchError("POLICY_DENIED", "Patch paths cannot traverse symbolic links");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
}

async function readTarget(target: string): Promise<{ exists: false } | ({ exists: true } & TextFileVersion)> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Patch target must be a regular file");
    if (stat.size > MAX_FILE_BYTES) throw new Error("Patch target exceeds the 512 KiB limit");
    const handle = await fs.open(target, constants.O_RDONLY);
    try { return { exists: true, ...decodeTextFile(await handle.readFile()) }; } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function atomicWrite(target: string, content: Uint8Array): Promise<void> {
  if (content.byteLength > MAX_FILE_BYTES) throw new Error("Patched file exceeds the 512 KiB limit");
  const temporary = `${target}.everpeace-${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { flag: "wx" });
  try { await fs.rename(temporary, target); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

async function exclusiveCreate(target: string, content: Uint8Array): Promise<void> {
  if (content.byteLength > MAX_FILE_BYTES) throw new Error("Patched file exceeds the 512 KiB limit");
  const handle = await fs.open(target, "wx");
  try { await handle.writeFile(content); }
  catch (error) { await handle.close(); await fs.rm(target, { force: true }); throw error; }
  await handle.close();
}

async function sameTargetVersion(target: string, expected: { exists: boolean; bytes?: Uint8Array }): Promise<boolean> {
  const current = await readTarget(target);
  return current.exists === expected.exists && (!current.exists || (expected.bytes !== undefined && current.sha256 === sha256Bytes(expected.bytes)));
}

interface PreparedPatch {
  operation: ApplyPatchOperation;
  target: string;
  before: { exists: false } | ({ exists: true } & TextFileVersion);
  after?: Buffer;
  afterText?: string;
}

async function preparePatch(
  operations: readonly ApplyPatchOperation[],
  workspace: string,
  options: ApplyPatchOptions,
): Promise<{ prepared: PreparedPatch[] } | { error: string; errorCode?: ApplyPatchErrorCode; remedy?: string }> {
  if (operations.length === 0 || operations.length > MAX_OPERATIONS) return { error: `apply_patch accepts 1-${MAX_OPERATIONS} operations`, errorCode: "INVALID_ARGUMENTS" };
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
      patchBytes += Buffer.byteLength(operation.content ?? operation.patch ?? operation.replace?.oldText ?? "", "utf8")
        + Buffer.byteLength(operation.replace?.newText ?? "", "utf8");
      if (patchBytes > MAX_PATCH_BYTES) throw new Error("Patch batch exceeds the 512 KiB limit");
      const target = path.resolve(root, operation.path);
      await assertSafeTarget(root, target);
      const relative = path.relative(root, target);
      if (relative.includes(":")) patchError("POLICY_DENIED", "Alternate data streams are not supported");
      if (!options.allowProtectedPaths && isProtectedPatchPath(relative)) patchError("POLICY_DENIED", "Editing protected workspace metadata requires full access");
      const key = path.relative(root, target).toLowerCase();
      if (seen.has(key)) throw new Error(`Duplicate patch path: ${operation.path}`);
      seen.add(key);
      const before = await readTarget(target);
      if (operation.action === "create" && before.exists) throw new Error(`File already exists: ${operation.path}`);
      if (operation.action !== "create" && !before.exists) throw new Error(`File does not exist: ${operation.path}`);
      if (operation.expectedSha256 && (!before.exists || before.sha256 !== operation.expectedSha256)) patchError("STALE_VERSION", `File changed since it was read: ${operation.path}`, "Read the file again before retrying the edit.");
      let after: string | undefined;
      if (operation.action === "create") {
        if (operation.content === undefined || operation.patch !== undefined || operation.replace !== undefined) patchError("INVALID_ARGUMENTS", "Create operations require content only");
        after = operation.content;
      } else if (operation.action === "update") {
        if (!before.exists) throw new Error(`File does not exist: ${operation.path}`);
        const methods = [operation.content, operation.patch, operation.replace].filter((item) => item !== undefined).length;
        if (methods !== 1) patchError("INVALID_ARGUMENTS", "Update operations require exactly one of content, patch, or replace");
        after = operation.replace !== undefined
          ? applyExactReplacement(before.text, operation.replace)
          : operation.patch === undefined ? operation.content : applyUnifiedPatch(before.text, operation.patch);
      } else if (operation.content !== undefined || operation.patch !== undefined || operation.replace !== undefined) {
        patchError("INVALID_ARGUMENTS", "Delete operations do not accept content, patch, or replace");
      }
      const afterBytes = after === undefined
        ? undefined
        : encodeTextFile(after, operation.action === "update" && before.exists ? before : undefined);
      if (afterBytes !== undefined && afterBytes.byteLength > MAX_FILE_BYTES) throw new Error("Patched file exceeds the 512 KiB limit");
      prepared.push({ operation, target, before, ...(afterBytes === undefined ? {} : { after: afterBytes, afterText: after! }) });
    }
    return { prepared };
  } catch (error) {
    return error instanceof ApplyPatchError
      ? { error: error.message, errorCode: error.code, ...(error.remedy ? { remedy: error.remedy } : {}) }
      : { error: error instanceof Error ? error.message : String(error), errorCode: "PATCH_FAILED" };
  }
}

function diffFor(item: PreparedPatch): string {
  const oldLines = (item.before.exists ? item.before.text : "").replace(/\r\n/gu, "\n").split("\n");
  const newLines = (item.afterText ?? "").replace(/\r\n/gu, "\n").split("\n");
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
  if ("error" in result) return { status: "rejected", files: [], diff: "", error: result.error, ...(result.errorCode ? { errorCode: result.errorCode } : {}), ...(result.remedy ? { remedy: result.remedy } : {}) };
  const files = result.prepared.map((item) => ({
    path: item.operation.path,
    action: item.operation.action,
    beforeSha256: item.before.exists ? item.before.sha256 : null,
    afterSha256: item.after === undefined ? null : sha256Bytes(item.after),
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
  if ("error" in preparedResult) return { status: "rejected", files: [], error: preparedResult.error, ...(preparedResult.errorCode ? { errorCode: preparedResult.errorCode } : {}), ...(preparedResult.remedy ? { remedy: preparedResult.remedy } : {}) };
  const prepared = preparedResult.prepared;
  const files: ApplyPatchFileResult[] = [];
  const applied: PreparedPatch[] = [];
  try {
    for (const item of prepared) {
      if (!(await sameTargetVersion(item.target, item.before))) patchError("STALE_VERSION", `File changed after the patch was prepared: ${item.operation.path}`, "Read the file again before retrying the edit.");
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
        const expectedAfter = { exists: item.after !== undefined, ...(item.after === undefined ? {} : { bytes: item.after }) };
        if (!(await sameTargetVersion(item.target, expectedAfter))) {
          rollbackConflicts.push(item.operation.path);
          continue;
        }
        if (item.before.exists) await atomicWrite(item.target, item.before.bytes);
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
      ...(error instanceof ApplyPatchError ? { errorCode: error.code, ...(error.remedy ? { remedy: error.remedy } : {}) } : { errorCode: "PATCH_FAILED" as const }),
    };
  }
}
