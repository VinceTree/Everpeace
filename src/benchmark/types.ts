import type { LoopEvent, LoopPhase } from "../agent/agent-loop.js";

export type BenchmarkRunStatus = "passed" | "failed" | "timed_out" | "error";

export interface BenchmarkVerification {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  expectedExitCode?: number;
  timeoutMs?: number;
}

export interface BenchmarkTask {
  id: string;
  prompt: string;
  workspacePath: string;
  tags?: readonly string[];
  timeoutMs?: number;
  verification?: BenchmarkVerification;
}

export interface BenchmarkMetricsSnapshot {
  durationMs: number;
  phases: readonly LoopPhase[];
  responses: number;
  toolCalls: number;
  toolFailures: number;
  retries: number;
  streamRecoveries: number;
  successfulStreamRecoveries: number;
  compactions: number;
  cancellations: number;
  steeringApplications: number;
}

export interface BenchmarkHarnessResult {
  manualInterventions?: number;
  unsafeActions?: number;
  notes?: string;
}

export interface BenchmarkHarnessContext {
  readonly task: BenchmarkTask;
  readonly signal: AbortSignal;
  readonly onPhase: (phase: LoopPhase) => void;
  readonly onEvent: (event: LoopEvent) => void;
}

export interface BenchmarkHarnessAdapter {
  readonly name: string;
  run(task: BenchmarkTask, context: BenchmarkHarnessContext): Promise<BenchmarkHarnessResult | void>;
}

export interface BenchmarkVerificationResult {
  attempted: true;
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

export interface BenchmarkRunResult {
  taskId: string;
  adapter: string;
  status: BenchmarkRunStatus;
  startedAt: string;
  durationMs: number;
  metrics: BenchmarkMetricsSnapshot;
  manualInterventions: number;
  unsafeActions: number;
  verification?: BenchmarkVerificationResult;
  error?: string;
  notes?: string;
}

export interface BenchmarkSuiteSummary {
  adapter: string;
  total: number;
  passed: number;
  failed: number;
  timedOut: number;
  errored: number;
  verified: number;
  verificationPassed: number;
  completionRate: number;
  verificationPassRate: number | null;
  totalDurationMs: number;
  totalToolCalls: number;
  totalRetries: number;
  totalManualInterventions: number;
  unsafeActions: number;
  results: readonly BenchmarkRunResult[];
}
