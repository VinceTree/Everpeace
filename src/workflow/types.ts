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

export interface WorkflowState {
  task_id: string;
  phase: WorkflowPhase;
  repair_attempts: number;
  max_repair_attempts: number;
  changed_paths: string[];
  checkpoint_available: boolean;
  last_verification?: VerificationResult;
  updated_at: string;
}

export interface WorkflowPatchFollowup {
  verification?: VerificationResult;
  prompt?: string;
}

export interface WorkflowReviewResult {
  passed: boolean;
  error?: string;
}

export interface WorkflowRunResult {
  state: WorkflowState;
  verification?: VerificationResult;
  review?: WorkflowReviewResult;
  prompt?: string;
  changed: boolean;
}

export function createWorkflowState(
  taskId: string,
  now = new Date().toISOString(),
): WorkflowState {
  return {
    task_id: taskId,
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
    passed: !result.cancelled && result.error === undefined && result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs,
    timedOut: result.timedOut === true,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}
