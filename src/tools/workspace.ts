import { captureWorkspaceSnapshot, type CaptureWorkspaceSnapshotOptions } from "../benchmark/workspace.js";

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
