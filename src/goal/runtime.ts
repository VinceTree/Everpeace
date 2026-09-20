import { randomUUID } from "node:crypto";
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
  return value.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 4_000);
}

export class GoalRuntime {
  readonly #store: GoalRuntimeStore;
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(store: GoalRuntimeStore, now = () => new Date(), id = randomUUID) {
    this.#store = store;
    this.#now = now;
    this.#id = id;
  }

  async get(): Promise<SessionGoal | undefined> {
    return this.#store.getGoal();
  }

  async create(input: GoalCreateInput): Promise<SessionGoal> {
    const objective = cleanObjective(input.objective);
    if (!objective) throw new Error("Goal objective cannot be empty");
    if (input.tokenBudget !== undefined && (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget <= 0)) {
      throw new Error("Goal token budget must be a positive integer");
    }
    const existing = await this.#store.getGoal();
    if (existing && !TERMINAL.has(existing.status)) {
      throw new Error("Cannot create a new goal while this session has an unfinished goal");
    }
    const at = this.#now().toISOString();
    const goal: SessionGoal = {
      goal_id: this.#id(), objective, status: "active",
      token_budget: input.tokenBudget ?? null, tokens_used: 0, usage_complete: true,
      time_used_seconds: 0, blocked_streak: 0, created_at: at, updated_at: at,
    };
    await this.#store.setGoal(goal);
    return goal;
  }

  async update(status: Extract<GoalStatus, "complete" | "blocked" | "paused">): Promise<SessionGoal> {
    const goal = await this.#store.getGoal();
    if (!goal) throw new Error("No active goal exists for this session");
    if (status === "blocked") {
      const blockedStreak = (goal.blocked_streak ?? 0) + 1;
      const updated = { ...goal, blocked_streak: blockedStreak, updated_at: this.#now().toISOString() };
      if (blockedStreak < 3) {
        await this.#store.setGoal(updated);
        throw new Error("A goal can be marked blocked only after the same blocker recurs for three consecutive turns");
      }
      updated.status = status;
      await this.#store.setGoal(updated);
      return updated;
    }
    const updated = { ...goal, status, blocked_streak: 0, updated_at: this.#now().toISOString() };
    await this.#store.setGoal(updated);
    return updated;
  }

  async resume(): Promise<SessionGoal> {
    const goal = await this.#store.getGoal();
    if (!goal || (goal.status !== "paused" && goal.status !== "blocked")) throw new Error("Only a paused or blocked goal can be resumed");
    const updated = { ...goal, status: "active" as const, blocked_streak: 0, updated_at: this.#now().toISOString() };
    await this.#store.setGoal(updated);
    return updated;
  }

  async recordUsage(usage: GoalUsage): Promise<SessionGoal | undefined> {
    const goal = await this.#store.getGoal();
    if (!goal || goal.status !== "active") return goal;
    const tokensUsed = Math.max(goal.tokens_used, usage.tokensUsed);
    let status: GoalStatus = goal.status;
    if (goal.token_budget !== null && tokensUsed >= goal.token_budget) status = "budget_limited";
    else if (goal.token_budget !== null && !usage.usageComplete) status = "usage_limited";
    const updated = { ...goal, tokens_used: tokensUsed, usage_complete: usage.usageComplete, time_used_seconds: Math.max(goal.time_used_seconds, usage.timeUsedSeconds), status, updated_at: this.#now().toISOString() };
    if (JSON.stringify(updated) !== JSON.stringify(goal)) await this.#store.setGoal(updated);
    return updated;
  }

  isTerminal(status: GoalStatus): boolean { return TERMINAL.has(status); }
}

export const GOAL_TOOL_DEFINITIONS = [
  { type: "function", name: "get_goal", description: "Get the current goal for this session, including status, budget, token and elapsed-time usage.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { type: "function", name: "create_goal", description: "Create a goal only when explicitly requested by the user. Fails if an unfinished goal exists.", parameters: { type: "object", properties: { objective: { type: "string" }, token_budget: { type: "integer", minimum: 1 } }, required: ["objective"], additionalProperties: false } },
  { type: "function", name: "update_goal", description: "Update the existing goal. Only complete, blocked after three recurring blockers, or paused at the user's explicit request are accepted.", parameters: { type: "object", properties: { status: { type: "string", enum: ["complete", "blocked", "paused"] } }, required: ["status"], additionalProperties: false } },
] as const;
