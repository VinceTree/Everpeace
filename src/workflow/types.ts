import type { BashResult } from "../tools/bash.js";

export type WorkflowPhase =
  | "understand"
  | "plan"
  | "implement"
  | "verify_fast"
  | "diagnose"
  | "verify_full"
  | "review"
  | "done"
  | "blocked";

export type VerificationTier = "fast" | "full";

export interface VerificationCommand {
  id: string;
  label: string;
  command: string;
  tier: VerificationTier;
  timeoutMs: number;
}
export interface VerificationResult {
  command: VerificationCommand;
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  skipped?: boolean;
  error?: string;
}

export type VerificationSuiteStatus = "passed" | "failed" | "unavailable";

export interface VerificationSuiteResult {
  status: VerificationSuiteStatus;
  results: VerificationResult[];
  skipped: VerificationCommand[];
  reason?: string;
  stale?: boolean;
  evidence?: VerificationEvidence;
}

/** Reported project evidence is distinct from a host-owned independent scorer. */
export interface VerificationEvidence {
  version: 1 | 2;
  projectChecks: "none" | "static_or_build" | "test_entry";
  tests: { state: "reported" | "unknown"; count?: number; skipped?: number; assertions: "unknown" };
  coverage: { state: "unknown" | "uncovered" | "partial" | "covered"; changedFiles: number; measuredFiles: number };
  changedLines?: { state: "unknown" | "uncovered" | "partial" | "covered"; total: number; measured: number; covered: number };
  independent: "not_run" | "passed" | "failed";
  source: "project_checks" | "supplemental_check";
  modifiedTests: boolean;
  workspaceRevision?: string;
  reportDigests: string[];
  independentSource?: { id: string; digest: string };
}

export type WorkflowResultClassification = "verified" | "unverified" | "failed" | "no_changes";
export type WorkflowTaskSource = "user" | "goal_continuation" | "session_resume" | "benchmark" | "exec";

export interface PriorUnverifiedWorkflow {
  task_id: string;
  result: "unverified" | "failed";
  reason?: string;
}

export interface WorkflowState {
  task_id: string;
  task_source?: WorkflowTaskSource;
  phase: WorkflowPhase;
  repair_attempts: number;
  max_repair_attempts: number;
  changed_paths: string[];
  checkpoint_available: boolean;
  result?: WorkflowResultClassification;
  result_reason?: string;
  tracking_limited?: boolean;
  verification_retries?: number;
  pending_verification?: boolean;
  workspace_revision?: string;
  verification_revision?: string;
  prior_unverified?: PriorUnverifiedWorkflow;
  last_verification?: VerificationResult;
  last_verification_suite?: VerificationSuiteResult;
  updated_at: string;
}

export interface WorkflowPatchFollowup {
  verification?: VerificationResult;
  prompt?: string;
  blocked?: boolean;
}

export interface WorkflowReviewResult {
  passed: boolean;
  error?: string;
}

export interface WorkflowRunResult {
  state: WorkflowState;
  verification?: VerificationResult;
  verificationSuite?: VerificationSuiteResult;
  review?: WorkflowReviewResult;
  prompt?: string;
  changed: boolean;
}

export function createWorkflowState(
  taskId: string,
  now = new Date().toISOString(),
  source: WorkflowTaskSource = "user",
): WorkflowState {
  return {
    task_id: taskId,
    task_source: source,
    phase: "understand",
    repair_attempts: 0,
    max_repair_attempts: 3,
    changed_paths: [],
    checkpoint_available: false,
    updated_at: now,
  };
}

export function verificationFromBash(
  command: VerificationCommand,
  result: BashResult,
  durationMs: number,
): VerificationResult {
  return {
    command,
    passed: !result.cancelled && !result.timedOut && !result.cleanupFailed && result.error === undefined && result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs,
    timedOut: result.timedOut === true,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}
