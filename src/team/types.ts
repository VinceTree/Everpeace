import type { AgentMode } from "../plan/runtime.js";
import type { RequestAttemptLedgerSnapshot, RequestPurpose } from "../agent/request-attempt-ledger.js";

export type TeamRole = "explorer" | "worker" | "reviewer";
export interface TeamOptions {
  enabled?: boolean;
  maxAgents?: number;
  models?: Partial<Record<TeamRole, string>>;
  tokenBudget?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  /** Explicitly continue an interrupted team belonging to this workspace/session. */
  resumeTeamId?: string;
}
export interface TeamTask {
  goal: string;
  acceptance: string;
  paths: string[];
  dependencies: string[];
  role: TeamRole;
  constraints?: string;
  context?: Array<{ source: string; summary: string }>;
}
export type MemberState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "integrated" | "conflict";
export interface TeamMember {
  agentId: string;
  taskId: string;
  sessionId?: string;
  sessionWorkspacePath?: string;
  modelId: string;
  task: TeamTask;
  state: MemberState;
  workspacePath?: string;
  summary?: string;
  changedPaths?: string[];
  verification?: string;
  integrationId?: string;
  error?: string;
  errorCode?: "SANDBOX_UNAVAILABLE" | `TEAM_${string}`;
  integrationEligible?: boolean;
  artifactHashes?: Record<string, string | null>;
}
export interface TeamSnapshot {
  version: 1;
  teamId: string;
  rootSessionId: string;
  workspacePath: string;
  mode: AgentMode;
  state: "running" | "interrupted" | "stopped" | "finished";
  options: TeamOptions;
  members: TeamMember[];
  usage: RequestAttemptLedgerSnapshot;
  openRequests: number;
  inFlight?: Array<{ id: number; purpose: RequestPurpose; agentId: string; modelId: string }>;
  modelBindings?: Record<string, string>;
  goalAccounting?: { goalId: string; initialTokensUsed: number; initialUsageComplete: boolean };
  diagnostics?: { duplicateReads: number; repeatedFailures: number };
  startedAt: number;
  elapsedMs: number;
}
export interface TeamEvent {
  type: "team_updated" | "agent_updated" | "team_usage" | "agent_integrated";
  teamId: string;
  agentId: string;
  taskId: string;
  state?: string;
  role?: TeamRole;
  modelId?: string;
  summary?: string;
  changedPaths?: string[];
  inputTokens?: number;
  outputTokens?: number;
  usageComplete?: boolean;
}
export interface TeamAgentBridge {
  stopForSensitiveContext?(exceptMemberId?: string): Promise<void>;
  transferDestinations?(): string;
  begin(mode: AgentMode): Promise<void>;
  setRootInput(text: string): void;
  signal(signal?: AbortSignal): AbortSignal;
  dispatch(name: string, args: string, mode: AgentMode, signal?: AbortSignal): Promise<string>;
  beforeVerification(signal?: AbortSignal): Promise<void>;
  end(): Promise<void>;
  cancel(reason?: unknown): Promise<void>;
  invalidate(message?: string): void;
  snapshot(): TeamSnapshot | undefined;
}
export function parseTeamTask(value: unknown): TeamTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid team task");
  const input = value as Record<string, unknown>;
  const bounded = (text: unknown, limit: number) => typeof text === "string" && Boolean(text.trim()) && text.length <= limit;
  if (!["explorer", "worker", "reviewer"].includes(String(input.role)) || !bounded(input.goal, 8192) || !bounded(input.acceptance, 8192) || !Array.isArray(input.paths) || !input.paths.length || input.paths.length > 20 || !Array.isArray(input.dependencies) || input.dependencies.length > 32) throw new Error("Specify a role, goal, acceptance, paths and dependencies");
  // oxlint-disable-next-line no-control-regex -- Explicitly reject or remove terminal control bytes at this boundary.
  if (input.paths.some((scope) => !bounded(scope, 2048) || typeof scope !== "string" || /^[/\\]/u.test(scope) || /[:\\\x00-\x1f]/u.test(scope) || scope.split("/").includes(".."))) throw new Error("Team paths must be workspace-relative files or directories");
  if (input.dependencies.some((id) => !bounded(id, 256))) throw new Error("Invalid team dependency");
  if (input.constraints !== undefined && !bounded(input.constraints, 8192)) throw new Error("Invalid member constraints");
  if (input.context !== undefined && (!Array.isArray(input.context) || input.context.length > 16 || input.context.some((entry: unknown) => !entry || typeof entry !== "object" || !bounded((entry as Record<string, unknown>).source, 256) || !bounded((entry as Record<string, unknown>).summary, 4096)) || JSON.stringify(input.context).length > 16 * 1024)) throw new Error("Member context must contain bounded summaries with sources");
  return { role: input.role as TeamRole, goal: input.goal as string, acceptance: input.acceptance as string, paths: [...new Set((input.paths as string[]).map((scope) => scope.split("/").filter((part) => part && part !== ".").join("/") || "."))], dependencies: [...new Set(input.dependencies as string[])], ...(input.constraints === undefined ? {} : { constraints: input.constraints as string }), ...(input.context === undefined ? {} : { context: (input.context as Array<{ source: string; summary: string }>).map(({ source, summary }) => ({ source, summary })) }) };
}
export function normalizeTeamOptions(value: TeamOptions = {}): Required<Pick<TeamOptions, "enabled" | "maxAgents" | "maxAttempts" | "timeoutMs">> & TeamOptions {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("Invalid team configuration");
  for (const [key, fallback] of [["maxAgents", 3], ["maxAttempts", 96], ["timeoutMs", 1_800_000]] as const) {
    const count = value[key] ?? fallback;
    if (!Number.isSafeInteger(count) || count < 1 || key === "maxAgents" && count > 3) throw new Error(`team.${key} is invalid`);
  }
  if (value.tokenBudget !== undefined && (!Number.isSafeInteger(value.tokenBudget) || value.tokenBudget < 1)) throw new Error("team.tokenBudget must be a positive integer");
  if (value.models !== undefined && (!value.models || typeof value.models !== "object" || Array.isArray(value.models) || Object.entries(value.models).some(([role, id]) => !["explorer", "worker", "reviewer"].includes(role) || typeof id !== "string" || !id.trim() || id.length > 256))) throw new Error("Invalid team role model registration");
  if (value.resumeTeamId !== undefined && !/^[a-f0-9-]{36}$/u.test(value.resumeTeamId)) throw new Error("Invalid team ID");
  return { models: Object.fromEntries((["explorer", "worker", "reviewer"] as const).filter((role) => value.models?.[role] !== undefined).map((role) => [role, value.models![role]])), enabled: value.enabled ?? true, maxAgents: value.maxAgents ?? 3, maxAttempts: value.maxAttempts ?? 96, timeoutMs: value.timeoutMs ?? 1_800_000, ...(value.tokenBudget === undefined ? {} : { tokenBudget: value.tokenBudget }), ...(value.resumeTeamId === undefined ? {} : { resumeTeamId: value.resumeTeamId }) };
}
