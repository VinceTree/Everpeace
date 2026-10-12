import type { AgentMode, SubmittedPlan } from "../plan/runtime.js";

export interface ApplicationTask<Agent> {
  readonly agent: Agent;
  readonly mode: AgentMode;
  readonly signal: AbortSignal;
}

type TaskAdmission<Agent> =
  | { status: "started"; task: ApplicationTask<Agent>; approvedPlan?: SubmittedPlan }
  | { status: "busy" | "stale_agent" | "no_approved_plan" };

/** Owns process-local admission and identity; runners own cleanup and settlement. */
export class ApplicationCoordinator<Agent> {
  private currentSessionId: string | undefined;
  private currentAgent: Agent | undefined;
  private currentMode: AgentMode = "default";
  private contextRevision = 0;
  private commandOperation = 0;
  private task: {
    handle: ApplicationTask<Agent>;
    controller: AbortController;
    contextRevision: number;
    approvalPublished: boolean;
  } | undefined;
  private approval: { sessionId: string; agent: Agent; submitted: SubmittedPlan } | undefined;

  get sessionId(): string | undefined { return this.currentSessionId; }
  get mode(): AgentMode { return this.currentMode; }
  get activeTask(): ApplicationTask<Agent> | undefined { return this.task?.handle; }

  setMode(mode: AgentMode): void {
    this.currentMode = mode;
    if (mode === "default") this.invalidatePlan();
  }

  setAgent(agent: Agent | undefined): void {
    if (agent === this.currentAgent) return;
    this.cancelTask(new Error("Agent replaced"));
    this.contextRevision += 1;
    this.currentAgent = agent;
    this.invalidatePlan();
  }

  /** Initial creation binds the already-admitted task without replacing it. */
  attachSession(sessionId: string): void {
    if (this.currentSessionId !== undefined) throw new Error("An active session is already attached");
    this.currentSessionId = sessionId;
  }

  /** Call only after the host successfully creates, restores, clears or forks. */
  replaceSession(sessionId: string | undefined): void {
    this.cancelTask(new Error("Session changed"));
    this.contextRevision += 1;
    this.currentSessionId = sessionId;
    this.setMode("default");
  }

  beginTask(agent: Agent, mode: AgentMode, executeApprovedPlan = false): TaskAdmission<Agent> {
    if (this.task) return { status: "busy" };
    if (agent !== this.currentAgent) return { status: "stale_agent" };
    const approvedPlan = executeApprovedPlan ? this.approvedPlan() : undefined;
    if (executeApprovedPlan && !approvedPlan) return { status: "no_approved_plan" };
    // Consumption and admission happen synchronously, before any awaited work.
    this.invalidatePlan();
    if (executeApprovedPlan) this.setMode("default");
    const controller = new AbortController();
    const handle: ApplicationTask<Agent> = { agent, mode: executeApprovedPlan ? "default" : mode, signal: controller.signal };
    this.task = { handle, controller, contextRevision: this.contextRevision, approvalPublished: false };
    return { status: "started", task: handle, ...(approvedPlan ? { approvedPlan } : {}) };
  }

  matchesTaskContext(handle: ApplicationTask<Agent>): boolean {
    return this.task?.handle === handle &&
      this.task.contextRevision === this.contextRevision &&
      handle.agent === this.currentAgent;
  }

  approvePlan(handle: ApplicationTask<Agent>, submitted: SubmittedPlan): boolean {
    const task = this.task;
    if (!task || !this.matchesTaskContext(handle) || task.approvalPublished || handle.signal.aborted || handle.mode !== "plan" ||
      !this.currentSessionId || !submitted.title.trim() || !submitted.plan.trim()) return false;
    task.approvalPublished = true;
    this.approval = { sessionId: this.currentSessionId, agent: handle.agent, submitted: { ...submitted } };
    this.setMode("plan");
    return true;
  }

  approvedPlan(): SubmittedPlan | undefined {
    const approved = this.approval;
    return approved && approved.sessionId === this.currentSessionId && approved.agent === this.currentAgent
      ? { ...approved.submitted }
      : undefined;
  }

  invalidatePlan(): void { this.approval = undefined; }

  cancelTask(reason?: unknown): void {
    if (!this.task) return;
    this.invalidatePlan();
    this.task.controller.abort(reason);
    // Keep admission occupied until the caller has awaited runner cleanup.
  }

  finishTask(handle: ApplicationTask<Agent>): boolean {
    if (this.task?.handle !== handle) return false;
    this.task = undefined;
    return true;
  }

  nextCommandOperation(): number { return ++this.commandOperation; }
  isCurrentCommandOperation(operation: number): boolean { return this.commandOperation === operation; }
}
