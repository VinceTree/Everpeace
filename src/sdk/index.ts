export type { TeamOptions, TeamRole, TeamEvent, TeamSnapshot, TeamMember } from "../team/types.js";
/**
 * Public programmatic API for running Everpeace coding tasks without a TUI.
 * The surface is intentionally narrow: callers pass a prompt and workspace,
 * receive the same streaming events the exec JSONL output uses, and get the
 * final classified result. Model credentials stay in the system keyring via
 * the default registry; a test or embedding host can inject its own.
 */
import { SystemAuthStorage } from "../storage/auth-storage.js";
import { ModelRegistry } from "../storage/model-registry.js";
import type { ExecDependencies, ExecOptions, ExecResult } from "../exec/types.js";
import { runExec } from "../exec/runtime.js";
export { CostSettingsStore, estimateRequestCost, summarizeCosts } from "../status/cost.js";
export type { CostEstimate, ModelPrice } from "../status/cost.js";
export { SearchSettingsStore } from "../tools/search-provider.js";
export { DiagnosticStore, diagnosticFreshness, diagnosticIdentity, runLiveDiagnostics, DOCTOR_LIMITS } from "../providers/doctor.js";
export type { DiagnosticResult, DiagnosticStage, DiagnosticState } from "../providers/doctor.js";

export type {
  ExecClassification,
  ExecEvent,
  ExecOptions,
  ExecResult,
  ExecStopReason,
} from "../exec/types.js";

export interface SdkTaskOptions extends Omit<ExecOptions, "workspacePath"> {
  /** Absolute or caller-relative workspace path; defaults to process.cwd(). */
  workspacePath?: string;
  /**
   * Optional registry override. When omitted, the SDK resolves the user's
   * system credential store and model registry exactly like the CLI.
   */
  registry?: ExecDependencies["registry"];
  /**
   * Optional SessionStore override for embedding hosts that isolate sessions.
   * When omitted, the default platform session directory is used.
   */
  sessionStore?: ExecDependencies["sessionStore"];
}

/**
 * Run one coding task and resolve with its classified result. Streaming
 * events arrive through `onEvent`; the caller decides whether to surface them.
 * The task never prompts on a TTY: permission prompts and structured
 * questions end the run as `interaction_required` instead.
 */
export async function runTask(options: SdkTaskOptions): Promise<ExecResult> {
  const registry = options.registry
    ?? new ModelRegistry({ authStorage: new SystemAuthStorage() });
  const { registry: _ignoredRegistry, sessionStore, ...rest } = options;
  const dependencies: ExecDependencies = {
    registry,
    ...(sessionStore === undefined ? {} : { sessionStore }),
  };
  return runExec(
    { ...rest, workspacePath: options.workspacePath ?? process.cwd() },
    dependencies,
  );
}
