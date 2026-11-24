import type { UiLanguage } from "../localization/language.js";
import { uiText } from "../localization/messages.js";
import type { SessionGoal } from "../storage/session-store.js";
import type { WebSession, WebState } from "./protocol.js";

export const DEFAULT_GOAL_ROUNDS = 256;

export function goalProjection(goal: SessionGoal, revision: number, language: UiLanguage) {
  const maxGoalRounds = goal.max_goal_rounds ?? Number.MAX_SAFE_INTEGER;
  const roundsStarted = goal.rounds_started ?? 0;
  const blocked = goal.status === "blocked" || goal.status === "budget_limited" || goal.status === "usage_limited";
  const blockCode = goal.status === "budget_limited" || goal.status === "usage_limited" ? goal.status
    : roundsStarted >= maxGoalRounds ? "goal_round_limit" : "goal_blocked";
  return {
    goal: {
      id: goal.goal_id, revision, objective: goal.objective,
      phase: blocked ? "blocked" : goal.status,
      ...(blocked ? { blockedReason: {
        code: blockCode.replaceAll("_", "-"),
        message: blockCode === "goal_round_limit" ? uiText("web.goal.increaseRounds", {}, language) : uiText(`web.turn.${blockCode}`, {}, language),
      } } : {}),
      maxGoalRounds,
    },
    roundsStarted, createdAt: Date.parse(goal.created_at) || 0, updatedAt: Date.parse(goal.updated_at) || 0,
  };
}

export function goalActivation(state: WebState, session: WebSession) {
  if (!session.goal) return;
  const turn = state.turns[session.id];
  const running = turn && !turn.stopping && !state.planSessions.includes(session.id);
  return {
    id: session.goal.goal_id, revision: session.goalRevision ?? 1,
    activation: session.goal.status === "active" && running ? "armed" as const : "disarmed" as const,
  };
}

export function goalView(state: WebState, session: WebSession) {
  const activation = goalActivation(state, session);
  if (!session.goal || !activation) return;
  const { goal, ...info } = goalProjection(session.goal, activation.revision, state.language);
  return { ...goal, ...info, activation: activation.activation };
}
