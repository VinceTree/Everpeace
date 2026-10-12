import type { LoopEvent, LoopPhase } from "../agent/agent-loop.js";
import type { RequestAttemptLedger } from "../agent/request-attempt-ledger.js";
import type { PerformanceTiming } from "../performance/trace.js";

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
  /** Evaluator-owned assertion used for scoring when it differs from harness-visible checks. */
  acceptance?: BenchmarkVerification;
  source?: BenchmarkTaskSource;
  fixture?: BenchmarkTaskFixture;
}

export interface BenchmarkTaskFixture {
  /** Optional evaluator-owned package-lock copied into a source that intentionally ships without one. */
  dependencyLock?: string;
  /** Optional deterministic dependency/bootstrap command run before any patch is applied. */
  setup?: BenchmarkVerification;
  /** Optional independent assertion proving the pinned source starts healthy. */
  pristineVerification?: BenchmarkVerification;
  /** Required substrings in a seeded failure, so unrelated process errors are not proof. */
  seedFailureContains?: readonly string[];
  /** Patch applied to the pinned source to introduce the benchmark defect and its acceptance assertion. */
  seedPatch: string;
  /** Patch applied after the seed to provide the reviewed reference repair. */
  referencePatch: string;
}

export interface BenchmarkTaskSource {
  sourceType?: "synthetic" | "seeded_upstream" | "upstream_issue";
  fixtureDirectory?: string;
  fixtureDigest?: string;
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
  cleanupFailed?: boolean;
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
  toolBatchSizes?: readonly number[];
  repeatedToolFailures?: number;
  requestComposition?: { count: number; instructionsBytes: number; toolsBytes: number; toolResultsBytes: number; requestBytes: number };
  toolResultOrder: readonly string[];
  firstToolStartDelayMs: number | null;
  firstModelEventDelayMs: number | null;
  firstModelTextDelayMs: number | null;
  retries: number;
  streamRecoveries: number;
  successfulStreamRecoveries: number;
  compactions: number;
  cancellations: number;
  steeringApplications: number;
  timings: Readonly<Record<string, PerformanceTiming>>;
}

export interface BenchmarkHarnessResult {
  teamMetrics?: { members: number; duplicateReads: number; repeatedFailures: number; conflicts: number };
  isolationFailed?: boolean;
  requestAttempts?: number;
  manualInterventions?: number;
  unsafeActions?: number;
  notes?: string;
  capabilities?: BenchmarkProviderCapabilities;
  usage?: BenchmarkTokenUsage;
  terminalOutcome?: "completed" | "stopped" | "plan_approved" | "plan_cancelled";
  stopReason?: string;
  workflowOutcome?: "verified" | "unverified" | "failed" | "no_changes";
  diagnosticRounds?: number;
  firstVerificationSuiteStatus?: "passed" | "failed" | "unavailable";
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
  /** Shared request-boundary accounting for adapters using the production model client. */
  readonly requestAttemptLedger?: RequestAttemptLedger;
}

export interface BenchmarkHarnessAdapter {
  readonly name: string;
  /** True when one adapter invocation already owns the complete diagnosis/repair lifecycle. */
  readonly managesRepairs?: boolean;
  /** The adapter does not settle until task-owned processes and writers have stopped. */
  readonly settlesOnCancellation?: boolean;
  run(task: BenchmarkTask, context: BenchmarkHarnessContext): Promise<BenchmarkHarnessResult | void>;
}

export interface BenchmarkVerificationResult {
  /** False when cancellation prevented the process from being launched. */
  attempted: boolean;
  cleanupFailed?: boolean;
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  error?: string;
}

export interface BenchmarkRunResult {
  teamMetrics?: BenchmarkHarnessResult["teamMetrics"];
  isolationFailed?: boolean;
  requestAttempts?: number;
  cleanupFailed?: boolean;
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
  terminalOutcome?: BenchmarkHarnessResult["terminalOutcome"];
  stopReason?: string;
  workflowOutcome?: BenchmarkHarnessResult["workflowOutcome"];
  diagnosticRounds?: number;
  firstVerificationSuiteStatus?: BenchmarkHarnessResult["firstVerificationSuiteStatus"];
  preparationError?: string;
  preparationOutcome?: import("./preparation-failure.js").PreparationOutcome;
}

export interface BenchmarkSuiteSummary {
  adapter: string;
  planned: number;
  executed: number;
  skipped: readonly BenchmarkSkippedRun[];
  statisticsComplete: boolean;
  stopReason?: string;
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

export interface BenchmarkSkippedRun {
  adapter?: string;
  taskId: string;
  repetition: number;
  reason: "budget_exhausted" | "usage_unknown" | "cancelled" | "cleanup_failed" | "isolation_failed" | "unsupported_platform" | "missing_toolchain" | "preparation_failed";
}
