import { persistState } from "../storage/persistence-error.js";
import { createHash, randomUUID } from "node:crypto";
import type { SessionGoal, GoalStatus } from "../storage/session-store.js";

export interface GoalUsage {
  tokensUsed: number;
  usageComplete: boolean;
  timeUsedSeconds: number;
}

export interface GoalRuntimeStore {
  getGoal(): Promise<SessionGoal | undefined>;
  setGoal(goal: SessionGoal): Promise<void>;
}

export interface GoalCreateInput {
  objective: string;
  tokenBudget?: number;
}

export type GoalCommand = { action: "status" | "pause" | "resume" } | { action: "create"; objective: string; tokenBudget?: number };

export function parseGoalCommand(value: string): GoalCommand {
  const text = value.trim();
  if (!text || text.toLowerCase() === "status") return { action: "status" };
  if (text.toLowerCase() === "pause") return { action: "pause" };
  if (text.toLowerCase() === "resume") return { action: "resume" };
  const match = /(?:^|\s)--tokens\s+(\d+)\s*$/iu.exec(text);
  const objective = (match ? text.slice(0, match.index) : text).trim();
  if (!objective) throw new Error("Usage: /goal <objective> [--tokens <positive integer>]");
  if (!match) return { action: "create", objective };
  const tokenBudget = Number(match[1]);
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) throw new Error("Goal token budget must be a positive integer");
  return { action: "create", objective, tokenBudget };
}

const TERMINAL = new Set<GoalStatus>(["complete", "blocked", "budget_limited", "usage_limited"]);

function cleanObjective(value: string): string {
  // oxlint-disable-next-line no-control-regex -- Explicitly reject or remove terminal control bytes at this boundary.
  return value.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 4_000);
}

export class GoalRuntime {
  readonly #store: GoalRuntimeStore;
  readonly #now: () => Date;
  readonly #id: () => string;
  #turnId: string | undefined;

  constructor(store: GoalRuntimeStore, now = () => new Date(), id = randomUUID) {
    this.#store = store;
    this.#now = now;
    this.#id = id;
  }

  async #getGoal(): Promise<SessionGoal | undefined> {
    return persistState("Goal state read failed", () => this.#store.getGoal());
  }

  async #setGoal(goal: SessionGoal): Promise<void> {
    await persistState("Goal persistence failed", () => this.#store.setGoal(goal));
  }

  async get(): Promise<SessionGoal | undefined> {
    return this.#getGoal();
  }

  /** Called once per host coding turn, never by model tool dispatch. */
  async beginTurn(signal?: AbortSignal): Promise<SessionGoal | undefined> {
    signal?.throwIfAborted();
    this.#turnId = randomUUID();
    const goal = await this.#getGoal();
    signal?.throwIfAborted();
    if (!goal || goal.status !== "active") return goal;
    const reportedLastTurn = goal.goal_turn_id !== undefined && goal.goal_turn_id === goal.blocked_turn_id;
    const updated = { ...goal, goal_turn_id: this.#turnId, blocked_streak: reportedLastTurn ? goal.blocked_streak ?? 0 : 0, updated_at: this.#now().toISOString() };
    await this.#setGoal(updated);
    return updated;
  }

  /** Verification may settle only the still-active goal that requested it. */
  async finalizeCompletion(intent: Pick<SessionGoal, "goal_id" | "goal_turn_id">): Promise<void> {
    const goal = await this.#getGoal();
    if (!goal || goal.goal_id !== intent.goal_id || goal.goal_turn_id !== intent.goal_turn_id || goal.status !== "active") return;
    await this.#setGoal({ ...goal, status: "complete", blocked_streak: 0, updated_at: this.#now().toISOString() });
  }

  async create(input: GoalCreateInput): Promise<SessionGoal> {
    const objective = cleanObjective(input.objective);
    if (!objective) throw new Error("Goal objective cannot be empty");
    if (input.tokenBudget !== undefined && (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget <= 0)) {
      throw new Error("Goal token budget must be a positive integer");
    }
    const existing = await this.#getGoal();
    if (existing && !TERMINAL.has(existing.status)) {
      throw new Error("Cannot create a new goal while this session has an unfinished goal");
    }
    const at = this.#now().toISOString();
    const goal: SessionGoal = {
      goal_id: this.#id(), objective, status: "active",
      token_budget: input.tokenBudget ?? null, tokens_used: 0, usage_complete: true,
      time_used_seconds: 0, blocked_streak: 0, created_at: at, updated_at: at,
      ...(this.#turnId === undefined ? {} : { goal_turn_id: this.#turnId }),
    };
    await this.#setGoal(goal);
    return goal;
  }

  async update(status: Extract<GoalStatus, "complete" | "blocked" | "paused">, blocker?: string): Promise<SessionGoal> {
    const goal = await this.#getGoal();
    if (!goal) throw new Error("No active goal exists for this session");
    if (goal.status !== "active") throw new Error("Only an active goal can be updated; stopped goals retain their status");
    if (status === "blocked") {
      const reason = typeof blocker === "string" ? cleanObjective(blocker).normalize("NFKC").toLowerCase() : "";
      if (!reason) throw new Error("Blocked status requires a stable description of the current blocker");
      if (!this.#turnId || goal.goal_turn_id !== this.#turnId) throw new Error("Blocked status requires a current host coding turn");
      if (goal.blocked_turn_id === this.#turnId) throw new Error("A blocker has already been reported for this host turn; wait for the next turn before reporting it again");
      const reasonHash = createHash("sha256").update(reason).digest("hex");
      const blockedStreak = (goal.blocked_reason_hash === reasonHash ? goal.blocked_streak ?? 0 : 0) + 1;
      const updated = { ...goal, blocked_streak: blockedStreak, blocked_turn_id: this.#turnId, blocked_reason_hash: reasonHash, updated_at: this.#now().toISOString() };
      if (blockedStreak < 3) {
        await this.#setGoal(updated);
        throw new Error("A goal can be marked blocked only after the same blocker recurs for three consecutive turns");
      }
      updated.status = status;
      await this.#setGoal(updated);
      return updated;
    }
    const updated = { ...goal, status, goal_turn_id: randomUUID(), blocked_streak: 0, updated_at: this.#now().toISOString() };
    await this.#setGoal(updated);
    return updated;
  }

  async resume(): Promise<SessionGoal> {
    const goal = await this.#getGoal();
    if (!goal || (goal.status !== "paused" && goal.status !== "blocked")) throw new Error("Only a paused or blocked goal can be resumed");
    const updated = { ...goal, status: "active" as const, goal_turn_id: randomUUID(), blocked_streak: 0, updated_at: this.#now().toISOString() };
    await this.#setGoal(updated);
    return updated;
  }

  async recordUsage(usage: GoalUsage): Promise<SessionGoal | undefined> {
    const goal = await this.#getGoal();
    if (!goal || goal.status !== "active") return goal;
    const tokensUsed = Math.max(goal.tokens_used, usage.tokensUsed);
    const usageComplete = goal.usage_complete && usage.usageComplete;
    let status: GoalStatus = goal.status;
    if (goal.token_budget !== null && tokensUsed >= goal.token_budget) status = "budget_limited";
    else if (goal.token_budget !== null && !usageComplete) status = "usage_limited";
    const updated = { ...goal, tokens_used: tokensUsed, usage_complete: usageComplete, time_used_seconds: Math.max(goal.time_used_seconds, usage.timeUsedSeconds), status, updated_at: this.#now().toISOString() };
    if (JSON.stringify(updated) !== JSON.stringify(goal)) await this.#setGoal(updated);
    return updated;
  }

  isTerminal(status: GoalStatus): boolean { return TERMINAL.has(status); }
}

export const GOAL_TOOL_DEFINITIONS = [
  { type: "function", name: "get_goal", description: "Get the current goal for this session, including status, budget, token and elapsed-time usage.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { type: "function", name: "create_goal", description: "Create a goal only when explicitly requested by the user. Fails if an unfinished goal exists.", parameters: { type: "object", properties: { objective: { type: "string" }, token_budget: { type: "integer", minimum: 1 } }, required: ["objective"], additionalProperties: false } },
  { type: "function", name: "update_goal", description: "Update the existing active goal. Complete only after auditing the full original objective against current evidence; host verification must also pass. Report blocked with a stable blocker description only when no meaningful progress remains possible. The same blocker must recur across three consecutive host coding turns; repeated calls in one turn do not count. Pause only at the user's explicit request.", parameters: { type: "object", properties: { status: { type: "string", enum: ["complete", "blocked", "paused"] }, blocker: { type: "string", description: "Required for blocked: a brief stable description of the same external blocker, without secrets or changing timestamps." } }, required: ["status"], additionalProperties: false } },
] as const;
