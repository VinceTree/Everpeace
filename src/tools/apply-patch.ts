import { ResourceCleanupError } from "../util/resource-cleanup-error.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { safeReadFile, safeCommitFile, SafeFileError } from "./safe-files.js";
import { isProtectedPatchPath } from "./sandbox-policy.js";
import { decodeTextFile, encodeTextFile, sha256Bytes, type TextFileVersion } from "./file-version.js";

const MAX_OPERATIONS = 20;
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 512 * 1024;

export type ApplyPatchAction = "create" | "update" | "delete";

export interface ApplyPatchOptions {
  /** Set only by the host after the user selected full access; never model arguments. */
  allowProtectedPaths?: boolean;
  signal?: AbortSignal;
  /** Host-only final policy check/fault injection; never accepted from model arguments. */
  beforeCommit?(relativePath: string): Promise<void>;
}

export interface ApplyPatchOperation {
  path: string;
  action: ApplyPatchAction;
  content?: string;
  patch?: string;
  replace?: {
    oldText: string;
    newText: string;
    matchMode?: "exact" | "line_whitespace";
  };
  expectedSha256?: string;
  /** Host observation/preview binding; never accepted from model JSON. */
  observedIdentity?: string;
}

export type ApplyPatchErrorCode =
  | "INVALID_ARGUMENTS"
  | "POLICY_DENIED"
  | "STALE_VERSION"
  | "REPLACEMENT_NOT_FOUND"
  | "REPLACEMENT_AMBIGUOUS"
  | "REPLACEMENT_UNCHANGED"
  | "PATCH_MISMATCH"
  | "PATCH_FAILED"
  | "FILE_CONFLICT"
  | "FILE_ACCESS_UNAVAILABLE";

export interface ApplyPatchFileResult {
  path: string;
  action: ApplyPatchAction;
  status: "applied" | "failed";
  beforeSha256?: string | null;
  afterSha256?: string | null;
  beforeFileIdentity?: string | null;
  afterFileIdentity?: string | null;
  error?: string;
  matchMode?: "exact" | "line_whitespace";
  matchedLines?: { start: number; end: number };
}

export interface ApplyPatchResult {
  status: "applied" | "failed" | "rejected";
  files: ApplyPatchFileResult[];
  diffSummary?: string;
  rolledBack?: boolean;
  rollbackConflicts?: string[];
  rollbackErrors?: string[];
  recoveryPath?: string;
  error?: string;
  errorCode?: ApplyPatchErrorCode;
  remedy?: string;
}

export interface ApplyPatchPreviewFile {
  path: string;
  action: ApplyPatchAction;
  beforeSha256: string | null;
  afterSha256: string | null;
  beforeFileIdentity?: string | null;
  diff: string;
  matchMode?: "exact" | "line_whitespace";
  matchedLines?: { start: number; end: number };
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
              description: "Unique text replacement. Defaults to exact; explicitly choose line_whitespace only to tolerate leading/trailing spaces or tabs in complete lines after an exact miss. Read the file first.",
              properties: {
                oldText: { type: "string" },
                newText: { type: "string" },
                matchMode: { type: "string", enum: ["exact", "line_whitespace"] },
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

function parseOperation(value: unknown, host = false): ApplyPatchOperation {
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
    if (replacement.matchMode !== undefined && replacement.matchMode !== "exact" && replacement.matchMode !== "line_whitespace") patchError("INVALID_ARGUMENTS", "replace.matchMode must be exact or line_whitespace");
    if (replacement.matchMode === "line_whitespace" && !/\S/u.test(replacement.oldText)) patchError("INVALID_ARGUMENTS", "replace.oldText must contain non-whitespace text for line_whitespace");
    if (Object.keys(replacement).some((key) => !["oldText", "newText", "matchMode"].includes(key))) patchError("INVALID_ARGUMENTS", "Patch replace contains unsupported fields");
    replace = { oldText: replacement.oldText, newText: replacement.newText, ...(replacement.matchMode === undefined ? {} : { matchMode: replacement.matchMode }) };
  }
  if (record.expectedSha256 !== undefined && record.expectedSha256 !== null && (typeof record.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(record.expectedSha256))) patchError("INVALID_ARGUMENTS", "expectedSha256 must be a SHA-256 hex digest");
  if (record.observedIdentity !== undefined && (!host || typeof record.observedIdentity !== 'string' || !/^\d+:\d+:\d+$/u.test(record.observedIdentity))) patchError('INVALID_ARGUMENTS', 'Invalid host file identity');
  if (Object.keys(record).some((key) => !["path", "action", "content", "patch", "replace", "expectedSha256", ...(host ? ['observedIdentity'] : [])].includes(key))) patchError("INVALID_ARGUMENTS", "Patch operation contains unsupported fields");
  return {
    path: record.path,
    action: record.action,
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(typeof record.patch === "string" ? { patch: record.patch } : {}),
    ...(replace ? { replace } : {}),
    ...(typeof record.expectedSha256 === "string" ? { expectedSha256: record.expectedSha256.toLowerCase() } : {}),
    ...(host && typeof record.observedIdentity === 'string' ? { observedIdentity: record.observedIdentity } : {}),
  };
}

export function parseApplyPatchArguments(argumentsJson: string): ApplyPatchOperation[] {
  let value: unknown;
  try { value = JSON.parse(argumentsJson); } catch { patchError("INVALID_ARGUMENTS", "Invalid apply_patch JSON arguments"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as Record<string, unknown>).operations)) patchError("INVALID_ARGUMENTS", "apply_patch requires an operations array");
  if (Object.keys(value as Record<string, unknown>).some((key) => key !== "operations")) patchError("INVALID_ARGUMENTS", "apply_patch contains unsupported fields");
  const operations = (value as { operations: unknown[] }).operations;
  if (operations.length === 0 || operations.length > MAX_OPERATIONS) patchError("INVALID_ARGUMENTS", `apply_patch accepts 1-${MAX_OPERATIONS} operations`);
  return operations.map(operation => parseOperation(operation));
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

function locateReplacement(original: string, replacement: NonNullable<ApplyPatchOperation["replace"]>): { text: string; matchMode: "exact" | "line_whitespace"; matchedLines: { start: number; end: number } } {
  const source = original.replace(/\r\n/gu, "\n");
  const oldText = replacement.oldText.replace(/\r\n/gu, "\n");
  const newText = replacement.newText.replace(/\r\n/gu, "\n");
  if (!oldText.length) patchError("INVALID_ARGUMENTS", "Replacement oldText must not be empty");
  if (oldText === newText) patchError("REPLACEMENT_UNCHANGED", "Replacement would not change the file", "Submit a replacement whose newText differs from oldText.");
  let first = source.indexOf(oldText);
  let end = first + oldText.length;
  let matchMode: "exact" | "line_whitespace" = "exact";
  if (first >= 0 && source.indexOf(oldText, first + 1) >= 0) patchError("REPLACEMENT_AMBIGUOUS", "Replacement oldText matches more than once", "Include more surrounding text so oldText matches exactly once.");
  if (first < 0 && replacement.matchMode === "line_whitespace") {
    const trimEdges = (line: string) => line.replace(/^[ \t]+|[ \t]+$/gu, "");
    const trailingNewline = oldText.endsWith("\n");
    const wanted = (trailingNewline ? oldText.slice(0, -1) : oldText).split("\n").map(trimEdges);
    const lines = source.split("\n");
    // Prefix matching avoids quadratic work for long blocks of repeated blank lines.
    const prefix = Array<number>(wanted.length).fill(0);
    for (let index = 1, length = 0; index < wanted.length; index++) {
      while (length && wanted[index] !== wanted[length]) length = prefix[length - 1]!;
      if (wanted[index] === wanted[length]) length++;
      prefix[index] = length;
    }
    const offsets: number[] = [];
    let offset = 0;
    let length = 0;
    for (let index = 0; index < lines.length; index++) {
      offsets.push(offset);
      const line = trimEdges(lines[index]!);
      while (length && line !== wanted[length]) length = prefix[length - 1]!;
      if (line === wanted[length]) length++;
      if (length === wanted.length && (!trailingNewline || index < lines.length - 1)) {
        if (first >= 0) patchError("REPLACEMENT_AMBIGUOUS", "Whitespace-tolerant replacement matches more than once", "Read the file and include more complete surrounding lines for a unique match.");
        first = offsets[index - wanted.length + 1]!;
        end = offset + lines[index]!.length + (trailingNewline ? 1 : 0);
      }
      if (length === wanted.length) length = prefix[length - 1]!;
      offset += lines[index]!.length + 1;
    }
    matchMode = "line_whitespace";
  }
  if (first < 0) patchError("REPLACEMENT_NOT_FOUND", "Replacement oldText was not found", "Read the current file and copy the exact text, or explicitly use line_whitespace with unique complete lines differing only in leading/trailing spaces or tabs.");
  if (source.slice(first, end) === newText) patchError("REPLACEMENT_UNCHANGED", "Replacement would not change the file", "Submit newText that changes the actual matched text.");
  const startLine = source.slice(0, first).split("\n").length;
  const endLine = startLine + source.slice(first, end).replace(/\n$/u, "").split("\n").length - 1;
  return { text: `${source.slice(0, first)}${newText}${source.slice(end)}`, matchMode, matchedLines: { start: startLine, end: endLine } };
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

type ObservedTextVersion = TextFileVersion & { identity: string; attributes?: number };
async function readTarget(target: string, workspace: string): Promise<{ exists: false } | ({ exists: true } & ObservedTextVersion)> {
  const value = await safeReadFile(workspace, path.relative(workspace, target));
  if (!value.exists) return { exists: false };
  if (value.bytes.length > MAX_FILE_BYTES) throw new Error("Patch target exceeds the 512 KiB limit");
  if (!value.identity) throw new SafeFileError('FILE_ACCESS_UNAVAILABLE');
  return { exists: true, ...decodeTextFile(value.bytes), identity: value.identity, ...(value.attributes === undefined ? {} : { attributes: value.attributes }) };
}

interface PreparedPatch {
  operation: ApplyPatchOperation;
  target: string;
  before: { exists: false } | ({ exists: true } & ObservedTextVersion);
  after?: Buffer;
  afterText?: string;
  matchMode?: "exact" | "line_whitespace";
  matchedLines?: { start: number; end: number };
  afterIdentity?: string;
}

async function preparePatch(
  operations: readonly ApplyPatchOperation[],
  workspace: string,
  options: ApplyPatchOptions,
): Promise<{ prepared: PreparedPatch[] } | { error: string; errorCode?: ApplyPatchErrorCode; remedy?: string }> {
  if (operations.length === 0 || operations.length > MAX_OPERATIONS) return { error: `apply_patch accepts 1-${MAX_OPERATIONS} operations`, errorCode: "INVALID_ARGUMENTS" };
  const root = path.resolve(workspace);
  const prepared: PreparedPatch[] = [];
  const seen = new Set<string>();
  let patchBytes = 0;
  try {
    for (const rawOperation of operations) {
      const operation = parseOperation(rawOperation, true);
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
      const before = await readTarget(target, root);
      if (operation.action === "create" && before.exists) throw new Error(`File already exists: ${operation.path}`);
      if (operation.action !== "create" && !before.exists) throw new Error(`File does not exist: ${operation.path}`);
      if (operation.expectedSha256 && (!before.exists || before.sha256 !== operation.expectedSha256)) patchError("STALE_VERSION", `File changed since it was read: ${operation.path}`, "Read the file again before retrying the edit.");
      if (operation.observedIdentity && (!before.exists || before.identity !== operation.observedIdentity)) patchError('STALE_VERSION', `File object changed since it was observed: ${operation.path}`, 'Read and review the current file again.');
      let after: string | undefined;
      let match: ReturnType<typeof locateReplacement> | undefined;
      if (operation.action === "create") {
        if (operation.content === undefined || operation.patch !== undefined || operation.replace !== undefined) patchError("INVALID_ARGUMENTS", "Create operations require content only");
        after = operation.content;
      } else if (operation.action === "update") {
        if (!before.exists) throw new Error(`File does not exist: ${operation.path}`);
        const methods = [operation.content, operation.patch, operation.replace].filter((item) => item !== undefined).length;
        if (methods !== 1) patchError("INVALID_ARGUMENTS", "Update operations require exactly one of content, patch, or replace");
        match = operation.replace === undefined ? undefined : locateReplacement(before.text, operation.replace);
        after = match !== undefined
          ? match.text
          : operation.patch === undefined ? operation.content : applyUnifiedPatch(before.text, operation.patch);
      } else if (operation.content !== undefined || operation.patch !== undefined || operation.replace !== undefined) {
        patchError("INVALID_ARGUMENTS", "Delete operations do not accept content, patch, or replace");
      }
      const afterBytes = after === undefined
        ? undefined
        : encodeTextFile(after, operation.action === "update" && before.exists ? before : undefined);
      if (afterBytes !== undefined && afterBytes.byteLength > MAX_FILE_BYTES) throw new Error("Patched file exceeds the 512 KiB limit");
      prepared.push({ operation, target, before, ...(afterBytes === undefined ? {} : { after: afterBytes, afterText: after! }), ...(match ? { matchMode: match.matchMode, matchedLines: match.matchedLines } : {}) });
    }
    return { prepared };
  } catch (error) {
    if (error instanceof ResourceCleanupError || options.signal?.aborted) throw error;
    return error instanceof ApplyPatchError
      ? { error: error.message, errorCode: error.code, ...(error.remedy ? { remedy: error.remedy } : {}) }
      : { error: error instanceof Error ? error.message : String(error), errorCode: error instanceof SafeFileError ? error.code : "PATCH_FAILED" };
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
    beforeFileIdentity: item.before.exists ? item.before.identity : null,
    diff: diffFor(item),
    ...(item.matchMode ? { matchMode: item.matchMode, matchedLines: item.matchedLines! } : {}),
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
      options.signal?.throwIfAborted();
      await options.beforeCommit?.(item.operation.path);
      const committed = await safeCommitFile(workspace, item.operation.path, item.before.exists ? item.before.bytes : undefined, item.after, options.signal, undefined, item.before.exists ? item.before.identity : undefined);
      if (committed.identity) item.afterIdentity = committed.identity;
      applied.push(item);
      files.push({ path: item.operation.path, action: item.operation.action, status: "applied", beforeSha256: item.before.exists ? item.before.sha256 : null, afterSha256: item.after === undefined ? null : sha256Bytes(item.after), beforeFileIdentity: item.before.exists ? item.before.identity : null, afterFileIdentity: item.afterIdentity ?? null, ...(item.matchMode ? { matchMode: item.matchMode, matchedLines: item.matchedLines! } : {}) });
    }
    return {
      status: "applied",
      files,
      diffSummary: prepared.map(({ operation }) => `${operation.action} ${operation.path}`).join("\n"),
    };
  } catch (error) {
    if (error instanceof ResourceCleanupError) throw error;
    const rollbackConflicts: string[] = [];
    const rollbackErrors: string[] = [];
    for (const item of [...applied].reverse()) {
      try {
        await safeCommitFile(workspace, item.operation.path, item.after, item.before.exists ? item.before.bytes : undefined, undefined, item.before.exists ? item.before.attributes : undefined, item.afterIdentity);
      } catch (rollbackError) {
        if (rollbackError instanceof ResourceCleanupError) throw rollbackError;
        if (rollbackError instanceof SafeFileError && (rollbackError.code === "STALE_VERSION" || rollbackError.code === "FILE_CONFLICT")) rollbackConflicts.push(item.operation.path);
        else rollbackErrors.push(`${item.operation.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    return {
      status: "failed",
      files,
      rolledBack: !options.signal?.aborted && rollbackConflicts.length === 0 && rollbackErrors.length === 0 && !(error instanceof SafeFileError && (error.recoveryPath || error.code === "FILE_ACCESS_UNAVAILABLE")),
      ...(rollbackConflicts.length > 0 ? { rollbackConflicts } : {}),
      ...(rollbackErrors.length > 0 ? { rollbackErrors } : {}),
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof ApplyPatchError ? { errorCode: error.code, ...(error.remedy ? { remedy: error.remedy } : {}) } : error instanceof SafeFileError ? { errorCode: error.code, ...(error.recoveryPath ? { recoveryPath: error.recoveryPath } : {}) } : { errorCode: "PATCH_FAILED" as const }),
    };
  }
}
