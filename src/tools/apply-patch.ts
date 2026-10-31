import { ResourceCleanupError } from "../util/resource-cleanup-error.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { safeReadFile, SafeFileError } from "./safe-files.js";
import { isProtectedPatchPath } from "./sandbox-policy.js";
import { decodeTextFile, encodeTextFile, sha256Bytes, type TextFileVersion } from "./file-version.js";
import { runFileBatch, type BatchState } from './file-batch.js';

const MAX_OPERATIONS = 20;
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;

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
  | "FILE_ACCESS_UNAVAILABLE"
  | "FILE_TOO_LARGE" | "PATCH_TOO_LARGE" | "BATCH_TOO_LARGE";
// Resource limits are distinct from malformed edits.

export interface ApplyPatchFileResult {
  path: string;
  action: ApplyPatchAction;
  status: "applied" | "failed" | 'rolled_back' | 'conflict' | 'unknown';
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
  batchId?: string;
  batchState?: BatchState;
  recoveryPending?: boolean;
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
  diffTruncated?: boolean;
  matchMode?: "exact" | "line_whitespace";
  matchedLines?: { start: number; end: number };
}

export interface ApplyPatchPreview {
  status: "ready" | "rejected";
  files: ApplyPatchPreviewFile[];
  diff: string;
  diffTruncated?: boolean;
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
  description: "Apply bounded workspace-relative file changes with version checks, conditional rollback and durable recovery. Multiple files are committed sequentially. Prefer this for code edits instead of rewriting files through Bash.",
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

export function applyUnifiedPatch(original: string, patch: string): string {
  type Line = { text: string; newline: boolean };
  const normalized = original.replace(/\r\n/gu, "\n");
  const source: Line[] = normalized === '' ? [] : normalized.split("\n").map(text => ({ text, newline: true }));
  if (source.length) { if (normalized.endsWith("\n")) source.pop(); else source[source.length - 1]!.newline = false; }
  const lines = patch.replace(/\r\n/gu, "\n").split("\n");
  if (lines.at(-1) === '') lines.pop();
  let cursor = 0;
  if (lines[0]?.startsWith('--- ') && lines[1]?.startsWith('+++ ')) cursor = 2;
  const output: Line[] = []; let sourceIndex = 0, delta = 0, hunks = 0, priorStart = -1;
  const fail = (detail: string): never => patchError('PATCH_MISMATCH', detail, 'Read the current file and submit corrected hunks.');
  while (cursor < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(lines[cursor++]!);
    if (!header) return fail('Invalid unified diff hunk header or unexpected text');
    const [oldLine, oldCount, newLine, newCount] = [Number(header[1]), Number(header[2] ?? 1), Number(header[3]), Number(header[4] ?? 1)];
    if ([oldLine, oldCount, newLine, newCount].some(value => !Number.isSafeInteger(value) || value < 0) || oldCount > 0 && oldLine === 0 || newCount > 0 && newLine === 0) fail('Invalid unified diff range');
    const oldStart = oldCount === 0 ? oldLine : oldLine - 1;
    const newStart = newCount === 0 ? newLine : newLine - 1;
    if (oldStart < sourceIndex || oldStart === priorStart || oldStart + oldCount > source.length || newStart !== oldStart + delta) fail('Unified diff range, overlap or continuity mismatch');
    for (; sourceIndex < oldStart; sourceIndex++) output.push({ ...source[sourceIndex]! });
    const removed: Line[] = []; const added: Line[] = [];
    let previous: { old?: Line; fresh?: Line } | undefined;
    while (cursor < lines.length && !lines[cursor]!.startsWith('@@ ')) {
      const line = lines[cursor++]!;
      if (line === '\\ No newline at end of file') {
        if (!previous || previous.old?.newline === false || previous.fresh?.newline === false) return fail('Misplaced no-newline marker');
        if (previous.old) previous.old.newline = false;
        if (previous.fresh) previous.fresh.newline = false;
        previous = undefined; continue;
      }
      const marker = line[0]; const text = line.slice(1); previous = {};
      if (marker === ' ' || marker === '-') { const old = { text, newline: true }; removed.push(old); previous.old = old; }
      if (marker === ' ' || marker === '+') { const fresh = { text, newline: true }; added.push(fresh); previous.fresh = fresh; }
      if (marker !== ' ' && marker !== '-' && marker !== '+') fail('Invalid unified diff body');
      if (removed.length > oldCount || added.length > newCount) fail('Unified diff body exceeds declared line counts');
    }
    if (removed.length !== oldCount || added.length !== newCount) fail('Unified diff declared line counts do not match its body');
    for (const line of removed) { const actual = source[sourceIndex++]; if (!actual || line.text !== actual.text || line.newline !== actual.newline) fail('Unified diff context or newline does not match the file'); }
    for (const line of added) output.push(line);
    priorStart = oldStart; delta += newCount - oldCount; hunks++;
  }
  if (!hunks) fail('Update patch must contain a unified diff hunk');
  for (; sourceIndex < source.length; sourceIndex++) output.push({ ...source[sourceIndex]! });
  if (output.some((line, index) => !line.newline && index !== output.length - 1)) fail('No-newline marker is not at the end of the file');
  return output.map(line => line.text + (line.newline ? '\n' : '')).join('');
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
  if (value.bytes.length > MAX_FILE_BYTES) patchError("FILE_TOO_LARGE", "Patch target exceeds the 16 MiB limit", "Split or reduce this file before editing.");
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
  let batchBytes = 0;
  try {
    for (const rawOperation of operations) {
      const operation = parseOperation(rawOperation, true);
      patchBytes += Buffer.byteLength(operation.content ?? operation.patch ?? operation.replace?.oldText ?? "", "utf8")
        + Buffer.byteLength(operation.replace?.newText ?? "", "utf8");
      if (patchBytes > MAX_PATCH_BYTES) patchError("PATCH_TOO_LARGE", "Patch payload exceeds the 512 KiB limit", "Use a smaller hunk or replacement and split the batch.");
      const target = path.resolve(root, operation.path);
      await assertSafeTarget(root, target);
      const relative = path.relative(root, target);
      if (/\.everpeace-(?:recovery|stage|batch)-/u.test(relative)) patchError('POLICY_DENIED', 'Recovery and staging materials are host-only');
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
      if (afterBytes !== undefined && afterBytes.byteLength > MAX_FILE_BYTES) patchError("FILE_TOO_LARGE", "Patched file exceeds the 16 MiB limit", "Reduce the resulting file size.");
      batchBytes += (before.exists ? before.bytes.length : 0) + (afterBytes?.length ?? 0);
      if (batchBytes > MAX_BATCH_BYTES) patchError("BATCH_TOO_LARGE", "Patch original and target bytes exceed 64 MiB", "Split the operation into smaller batches.");
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

function previewPrefix(text: string, limit: number): string { const bytes = Buffer.from(text); limit = Math.max(0, limit); if (bytes.length <= limit) return text; let end = limit; while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--; return bytes.subarray(0, end).toString('utf8'); }
function diffFor(item: PreparedPatch): { diff: string; truncated: boolean } {
  const oldText = (item.before.exists ? item.before.text : '').replace(/\r\n/gu, '\n');
  const newText = (item.afterText ?? '').replace(/\r\n/gu, '\n');
  let start = 0; while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
  start = oldText.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  let oldEnd = oldText.length, newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) { oldEnd--; newEnd--; }
  const oldBoundary = oldText.indexOf('\n', oldEnd), newBoundary = newText.indexOf('\n', newEnd);
  oldEnd = oldBoundary < 0 ? oldText.length : oldBoundary + 1; newEnd = newBoundary < 0 ? newText.length : newBoundary + 1;
  const oldPart = oldText.slice(start, oldEnd), newPart = newText.slice(start, newEnd);
  const count = (text: string) => text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  const startLine = count(oldText.slice(0, start));
  const removed = count(oldPart), added = count(newPart);
  const render = (text: string, marker: string) => { const limited = previewPrefix(text, 30 * 1024); const lines = limited === '' ? [] : limited.split('\n'); if (limited.endsWith('\n')) lines.pop(); const body = lines.map(line => marker + line).join('\n'); return body + (limited && !limited.endsWith('\n') && limited === text ? '\n\\ No newline at end of file' : ''); };
  const raw = [item.before.exists ? `--- a/${item.operation.path}` : '--- /dev/null', item.operation.action === 'delete' ? '+++ /dev/null' : `+++ b/${item.operation.path}`, `@@ -${removed ? startLine + 1 : startLine},${removed} +${added ? startLine + 1 : startLine},${added} @@`, render(oldPart, '-'), render(newPart, '+')].filter(Boolean).join('\n');
  const diff = previewPrefix(raw, 64 * 1024);
  return { diff, truncated: diff !== raw || Buffer.byteLength(oldPart) > 30 * 1024 || Buffer.byteLength(newPart) > 30 * 1024 };
}

export async function previewApplyPatch(
  operations: readonly ApplyPatchOperation[],
  workspace: string,
  options: ApplyPatchOptions = {},
): Promise<ApplyPatchPreview> {
  const result = await preparePatch(operations, workspace, options);
  if ("error" in result) return { status: "rejected", files: [], diff: "", error: result.error, ...(result.errorCode ? { errorCode: result.errorCode } : {}), ...(result.remedy ? { remedy: result.remedy } : {}) };
  let remaining = 256 * 1024;
  const files = result.prepared.map((item) => {
    const preview = diffFor(item); const diff = previewPrefix(preview.diff, remaining); remaining -= Buffer.byteLength(diff) + 1;
    return ({
    path: item.operation.path,
    action: item.operation.action,
    beforeSha256: item.before.exists ? item.before.sha256 : null,
    afterSha256: item.after === undefined ? null : sha256Bytes(item.after),
    beforeFileIdentity: item.before.exists ? item.before.identity : null,
    diff, diffTruncated: preview.truncated || diff !== preview.diff,
    ...(item.matchMode ? { matchMode: item.matchMode, matchedLines: item.matchedLines! } : {}),
  }); });
  return { status: "ready", files, diff: files.map((file) => file.diff).join("\n"), diffTruncated: files.some(file => file.diffTruncated) };
}

export async function runApplyPatch(
  operations: readonly ApplyPatchOperation[],
  workspace: string,
  options: ApplyPatchOptions = {},
): Promise<ApplyPatchResult> {
  const preparedResult = await preparePatch(operations, workspace, options);
  if ("error" in preparedResult) return { status: "rejected", files: [], error: preparedResult.error, ...(preparedResult.errorCode ? { errorCode: preparedResult.errorCode } : {}), ...(preparedResult.remedy ? { remedy: preparedResult.remedy } : {}) };
  const prepared = preparedResult.prepared;
  const batch = await runFileBatch(workspace, prepared.map(item => ({ path: path.relative(path.resolve(workspace), item.target), ...(item.before.exists ? { before: item.before.bytes, beforeIdentity: item.before.identity, ...(item.before.attributes === undefined ? {} : { attributes: item.before.attributes }) } : {}), ...(item.after === undefined ? {} : { after: item.after }) })), { ...(options.signal ? { signal: options.signal } : {}), ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) });
  const files: ApplyPatchFileResult[] = prepared.slice(0, batch.identities.length).map((item, index) => ({ path: item.operation.path, action: item.operation.action, status: batch.state === 'committed' ? 'applied' : batch.outcomes?.find(op => path.normalize(op.path) === path.normalize(item.operation.path))?.state === 'rolled_back' ? 'rolled_back' : 'unknown', beforeSha256: item.before.exists ? item.before.sha256 : null, afterSha256: item.after === undefined ? null : sha256Bytes(item.after), beforeFileIdentity: item.before.exists ? item.before.identity : null, afterFileIdentity: batch.identities[index] ?? null, ...(item.matchMode ? { matchMode: item.matchMode, matchedLines: item.matchedLines! } : {}) }));
  return { status: batch.state === 'committed' ? 'applied' : 'failed', files, batchId: batch.id, batchState: batch.state, ...(batch.error && batch.state === 'committed' ? { recoveryPending: true } : {}), ...(batch.state === 'committed' ? { diffSummary: prepared.map(({ operation }) => `${operation.action} ${operation.path}`).join('\n') } : { rolledBack: batch.state === 'rolled_back', rollbackConflicts: batch.conflicts, error: batch.error instanceof Error ? batch.error.message : 'File batch did not commit', ...(batch.error instanceof SafeFileError ? { errorCode: batch.error.code, ...(batch.error.recoveryPath ? { recoveryPath: batch.error.recoveryPath } : {}) } : { errorCode: 'PATCH_FAILED' as const }) }) };
}
