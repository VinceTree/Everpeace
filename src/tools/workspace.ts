import { randomUUID } from "node:crypto";
import { captureWorkspaceSnapshot, type CaptureWorkspaceSnapshotOptions } from "../benchmark/workspace.js";
import { listWorkspaceChanges, readWorkspaceChange, type WorkspaceChangeIndex } from "./workspace-review.js";

const WORKSPACE_CHANGE_PAGE_SIZE = 100;
const WORKSPACE_REVIEW_CACHE_BYTES = 16 * 1024 * 1024;

export const WORKSPACE_STATUS_TOOL_DEFINITION = {
  type: "function",
  name: "workspace_status",
  description: "Inspect the current workspace Git status without modifying files.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  strict: true,
} as const;

export const WORKSPACE_DIFF_TOOL_DEFINITION = {
  type: "function",
  name: "workspace_diff",
  description: "Inspect a bounded unified diff of current workspace changes without modifying files.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  strict: true,
} as const;

export const LIST_WORKSPACE_CHANGES_TOOL_DEFINITION = {
  type: "function",
  name: "list_workspace_changes",
  description: "List staged, unstaged, and untracked workspace changes from a bounded captured snapshot. Call without a continuation to refresh.",
  parameters: {
    type: "object",
    properties: { continuation: { type: ["string", "null"], description: "Opaque continuation from a previous page." } },
    required: [],
    additionalProperties: false,
  },
  strict: true,
} as const;

export const READ_WORKSPACE_CHANGE_TOOL_DEFINITION = {
  type: "function",
  name: "read_workspace_change",
  description: "Read bounded detail for one change reference returned by list_workspace_changes.",
  parameters: {
    type: "object",
    properties: { reference: { type: "string", description: "Opaque change reference from list_workspace_changes." } },
    required: ["reference"],
    additionalProperties: false,
  },
  strict: true,
} as const;

export const WORKSPACE_REVIEW_TOOL_DEFINITIONS = [
  LIST_WORKSPACE_CHANGES_TOOL_DEFINITION,
  READ_WORKSPACE_CHANGE_TOOL_DEFINITION,
] as const;

interface RetainedWorkspaceReview {
  id: string;
  index: WorkspaceChangeIndex;
  bytes: number;
}

interface WorkspaceReviewCursor {
  snapshot: RetainedWorkspaceReview;
  offset: number;
}

function parsedRecord(value: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Invalid workspace review arguments"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid workspace review arguments");
  return parsed as Record<string, unknown>;
}

/** Process-local captured change indexes. References deliberately expire on Agent replacement. */
export class WorkspaceReviewSession {
  readonly #workspacePath: string;
  readonly #snapshots = new Map<string, RetainedWorkspaceReview>();
  readonly #cursors = new Map<string, WorkspaceReviewCursor>();
  #bytes = 0;

  constructor(workspacePath: string) {
    this.#workspacePath = workspacePath;
  }

  async list(argumentsJson: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const input = parsedRecord(argumentsJson);
    if (Object.keys(input).some((key) => key !== "continuation")) throw new Error("Invalid workspace review arguments");
    if (input.continuation !== undefined && input.continuation !== null && typeof input.continuation !== "string") throw new Error("Invalid workspace review continuation");
    if (typeof input.continuation === "string") {
      const cursor = this.#cursors.get(input.continuation);
      if (!cursor) throw new Error("Workspace review continuation is unknown or expired; list the changes again");
      this.#cursors.delete(input.continuation);
      return this.#page(cursor.snapshot, cursor.offset);
    }
    const index = await listWorkspaceChanges(this.#workspacePath, signal);
    const snapshot: RetainedWorkspaceReview = {
      id: randomUUID(),
      index,
      bytes: Buffer.byteLength(JSON.stringify(index), "utf8"),
    };
    this.#snapshots.set(snapshot.id, snapshot);
    this.#bytes += snapshot.bytes;
    this.#evict();
    return this.#page(snapshot, 0);
  }

  async read(argumentsJson: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const input = parsedRecord(argumentsJson);
    if (Object.keys(input).some((key) => key !== "reference") || typeof input.reference !== "string" || !input.reference) {
      throw new Error("read_workspace_change requires a change reference");
    }
    const match = /^([^:]+):(\d+)$/u.exec(input.reference);
    const snapshot = match ? this.#snapshots.get(match[1]!) : undefined;
    const position = match ? Number(match[2]) : -1;
    const entry = snapshot?.index.entries[position];
    if (!snapshot || !entry) throw new Error("Workspace change reference is unknown or expired; list the changes again");
    const detail = await readWorkspaceChange(this.#workspacePath, entry, signal);
    return {
      status: "ok",
      snapshot: snapshot.id,
      captured_at: snapshot.index.capturedAt,
      reference: input.reference,
      ...detail,
    };
  }

  clear(): void {
    this.#snapshots.clear();
    this.#cursors.clear();
    this.#bytes = 0;
  }

  #page(snapshot: RetainedWorkspaceReview, offset: number): Record<string, unknown> {
    const entries = snapshot.index.entries.slice(offset, offset + WORKSPACE_CHANGE_PAGE_SIZE).map((entry, index) => ({
      ...entry,
      reference: `${snapshot.id}:${offset + index}`,
    }));
    const nextOffset = offset + entries.length;
    let continuation: string | null = null;
    if (nextOffset < snapshot.index.entries.length) {
      continuation = randomUUID();
      this.#cursors.set(continuation, { snapshot, offset: nextOffset });
    }
    return {
      status: "ok",
      snapshot: snapshot.id,
      captured_at: snapshot.index.capturedAt,
      repository_root: snapshot.index.repositoryRoot,
      entries,
      total: snapshot.index.entries.length,
      continuation,
      has_more: continuation !== null,
    };
  }

  #evict(): void {
    while (this.#bytes > WORKSPACE_REVIEW_CACHE_BYTES && this.#snapshots.size > 1) {
      const oldest = this.#snapshots.values().next().value as RetainedWorkspaceReview | undefined;
      if (!oldest) break;
      this.#snapshots.delete(oldest.id);
      this.#bytes -= oldest.bytes;
      for (const [id, cursor] of this.#cursors) if (cursor.snapshot === oldest) this.#cursors.delete(id);
    }
  }
}

export function isWorkspaceReviewTool(name: string): boolean {
  return WORKSPACE_REVIEW_TOOL_DEFINITIONS.some((tool) => tool.name === name);
}

export interface WorkspaceInspection {
  status: "ok" | "error";
  workspacePath: string;
  git?: {
    root: string;
    head: string | null;
    branch: string | null;
    status: string;
    diff: string;
    diffHash: string | null;
    diffTruncated?: boolean;
  };
  error?: string;
}

export async function inspectWorkspace(
  workspacePath: string,
  options: CaptureWorkspaceSnapshotOptions = {},
): Promise<WorkspaceInspection> {
  const snapshot = await captureWorkspaceSnapshot(workspacePath, options);
  if (!snapshot.git) return { status: "error", workspacePath, error: snapshot.error ?? "Workspace is not a Git repository" };
  return {
    status: "ok",
    workspacePath,
    git: {
      ...snapshot.git,
      diff: snapshot.git.diff ?? "",
    },
    ...(snapshot.error ? { error: snapshot.error } : {}),
  };
}

export async function workspaceStatus(workspacePath: string, signal?: AbortSignal): Promise<WorkspaceInspection> {
  return inspectWorkspace(workspacePath, { ...(signal ? { signal } : {}) });
}

export async function workspaceDiff(workspacePath: string, signal?: AbortSignal): Promise<WorkspaceInspection> {
  return inspectWorkspace(workspacePath, { ...(signal ? { signal } : {}) });
}

export function formatWorkspaceInspection(value: WorkspaceInspection, diff = false): string {
  if (value.status === "error") return JSON.stringify(value);
  const git = value.git!;
  return JSON.stringify({
    status: "ok",
    workspacePath: value.workspacePath,
    branch: git.branch,
    head: git.head,
    changes: git.status,
    ...(diff ? { diff: git.diff, ...(git.diffTruncated ? { diffTruncated: true } : {}) } : {}),
    ...(value.error ? { warning: value.error } : {}),
  });
}
