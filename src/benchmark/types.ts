import type { LoopEvent, LoopPhase } from "../agent/agent-loop.js";

export type BenchmarkRunStatus = "passed" | "failed" | "timed_out" | "error";

export type BenchmarkTaskPhase = "inspect" | "plan" | "implement" | "test" | "diagnose" | "verify" | "summarize";

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
  maxRepairAttempts?: number;
  verification?: BenchmarkVerification;
  source?: BenchmarkTaskSource;
}

export interface BenchmarkTaskSource {
  repositoryUrl: string;
  commit: string;
  issue: string;
  license?: string;
}

export interface BenchmarkWorkspaceGitSnapshot {
  root: string;
  head: string | null;
  branch: string | null;
  status: string;
  diffHash: string | null;
  diff?: string;
  diffTruncated?: boolean;
}

export interface BenchmarkWorkspaceSnapshot {
  capturedAt: string;
  workspacePath: string;
  git?: BenchmarkWorkspaceGitSnapshot;
  error?: string;
}

export interface BenchmarkProviderCapabilities {
  provider: string;
  baseUrl: string;
  model: string;
  streaming: boolean;
  streamRecovery: boolean;
  nativeCompaction: boolean;
  promptCache: boolean;
  parallelToolCalls: boolean;
  contextWindow: number | null;
}

export interface BenchmarkMetricsSnapshot {
  durationMs: number;
  phases: readonly LoopPhase[];
  samplingAttempts: number;
  responses: number;
  responseRejections: number;
  incompleteResponses: number;
  invalidToolCalls: number;
  toolCalls: number;
  toolResults: number;
  unclosedToolCalls: number;
  toolFailures: number;
  toolBatches: number;
  toolResultOrder: readonly string[];
  firstToolStartDelayMs: number | null;
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
  capabilities?: BenchmarkProviderCapabilities;
  usage?: BenchmarkTokenUsage;
}

export interface BenchmarkTokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheObservedInputTokens?: number;
  complete: boolean;
}

export interface BenchmarkArtifactSink {
  write(name: string, content: string): Promise<string | undefined>;
}

export interface BenchmarkHarnessContext {
  readonly task: BenchmarkTask;
  readonly signal: AbortSignal;
  readonly attempt: number;
  readonly phase: BenchmarkTaskPhase;
  readonly previousVerification?: BenchmarkVerificationResult;
  readonly workspaceBefore?: BenchmarkWorkspaceSnapshot;
  readonly onPhase: (phase: LoopPhase) => void;
  readonly onEvent: (event: LoopEvent) => void;
  readonly writeArtifact?: (name: string, content: string) => Promise<string | undefined>;
  readonly tokenBudgetRemaining?: number;
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
  attempts: number;
  metrics: BenchmarkMetricsSnapshot;
  manualInterventions: number;
  unsafeActions: number;
  verification?: BenchmarkVerificationResult;
  verificationAttempts?: readonly BenchmarkVerificationResult[];
  workspaceBefore?: BenchmarkWorkspaceSnapshot;
  workspaceAfter?: BenchmarkWorkspaceSnapshot;
  artifacts?: readonly string[];
  capabilities?: BenchmarkProviderCapabilities;
  error?: string;
  notes?: string;
  usage?: BenchmarkTokenUsage;
  repetition?: number;
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
  totalAttempts: number;
  totalRepairAttempts: number;
  totalToolCalls: number;
  totalRetries: number;
  totalManualInterventions: number;
  unsafeActions: number;
  results: readonly BenchmarkRunResult[];
  repetitions?: number;
  usage?: BenchmarkTokenUsage;
}
