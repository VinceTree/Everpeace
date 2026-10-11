import type { TeamOptions, TeamEvent, TeamSnapshot } from "../team/types.js";
import type { LoopStopReason } from "../agent/agent-loop.js";
import type { AgentInteractionRequired } from "../agent/react-agent.js";
import type { RequestAttemptLedgerSnapshot } from "../agent/request-attempt-ledger.js";
import type { PermissionPolicy } from "../permissions/policy.js";
import type { RegisteredModel, ResolvedModels } from "../storage/model-registry.js";
import type { SessionStore } from "../storage/session-store.js";
import type {
  ProductionAgentHandle,
  ProductionAgentOptions,
  ProductionCommandExecutor,
  ProductionCommandExecutorOptions,
} from "../runtime/production.js";
import type { WorkflowPhase, WorkflowResultClassification } from "../workflow/types.js";

export type ExecClassification =
  | "success"
  | "runtime_error"
  | "configuration_error"
  | "verification_failed"
  | "limit_reached"
  | "interaction_required"
  | "cancelled";

export type ExecStopReason = LoopStopReason | "aborted" | "output_closed";

export type ExecEvent =
  | { type: "performance_report"; report: import("../performance/task-report.js").TaskPerformanceReport }
  | { type: "cost_estimated"; estimate: import("../status/cost.js").CostEstimate }
  | TeamEvent
  | {
      type: "session_started";
      sessionId: string;
      modelId: string;
      modelName: string;
      workspacePath: string;
      parentSessionId?: string;
    }
  | { type: "assistant_message"; text: string }
  | { type: "tool_started"; name: string; callId?: string }
  | { type: "tool_finished"; name: string; callId?: string; status?: string }
  | {
      type: "workflow_updated";
      phase: WorkflowPhase;
      taskId?: string;
      result?: WorkflowResultClassification;
      resultReason?: string;
      changedPaths?: readonly string[];
      repairAttempts?: number;
      maxRepairAttempts?: number;
      pendingVerification?: boolean;
      verificationEvidence?: import("../workflow/types.js").VerificationEvidence;
    }
  | ({ type: "interaction_required" } & AgentInteractionRequired);

export interface ExecOptions {
  prompt: string;
  team?: TeamOptions;
  workspacePath: string;
  model?: string;
  /** Continue a same-workspace Session in an independent child; requires a new prompt. */
  resume?: string;
  /** Inspect the workspace and emit a submitted plan without implementing it. */
  plan?: boolean;
  /** Override the effective permission mode; `full-access` is not selectable. */
  permissionMode?: "read-only" | "ask" | "workspace-write";
  tokenBudget?: number;
  timeoutMs?: number;
  maxSteps?: number;
  signal?: AbortSignal;
  /** CLI supplies 130 for SIGINT and 143 for SIGTERM. */
  signalExitCode?: 130 | 143;
  version?: string;
  onEvent?(event: ExecEvent): void | Promise<void>;
}

export interface ExecResult {
  performanceReport?: import("../performance/task-report.js").TaskPerformanceReport;
  team?: TeamSnapshot;
  exitCode: number;
  classification: ExecClassification;
  status: string;
  sessionId?: string;
  assistantText?: string;
  usageComplete: boolean;
  usage?: RequestAttemptLedgerSnapshot;
  workflowResult?: WorkflowResultClassification;
  stopReason?: ExecStopReason;
  interaction?: AgentInteractionRequired;
  error?: string;
}

export interface ExecModelRegistry {
  resolveAll(): Promise<ResolvedModels>;
}

export interface ExecDependencies {
  registry: ExecModelRegistry;
  sessionStore?: SessionStore;
  loadPermissionPolicy?(workspacePath: string): Promise<PermissionPolicy>;
  createAgent?(options: ProductionAgentOptions): ProductionAgentHandle;
  createCommandExecutor?(options: ProductionCommandExecutorOptions): ProductionCommandExecutor;
}

export interface ExecSelectedModel {
  model: RegisteredModel;
  selector: "only" | "id" | "name";
}
