import type { PlanQuestion, SubmittedPlan } from "../plan/runtime.js";
import type { WebPermissionMode } from "../permissions/policy.js";
import type { SessionGoal, SessionTeamReference, TimelineInputFile, TimelinePlan, WebTurnOutcome } from "../storage/session-store.js";

export interface WebModel {
  id: string;
  name: string;
  provider: string;
  supportsImages: boolean;
}

export interface WebSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  modelId: string;
  blank: boolean;
  permissionMode?: WebPermissionMode;
  goal?: SessionGoal;
  goalRevision?: number;
  team?: SessionTeamReference;
}

export interface WebMessage {
  kind: "user" | "assistant" | "system" | "tool" | "output" | "error";
  text: string;
  files?: TimelineInputFile[];
  plan?: TimelinePlan;
  webTurnStarted?: true;
  webTurnOutcome?: WebTurnOutcome;
  webSkillName?: string;
  webInput?: { id: string; requestId: string };
}

export interface WebInboxMessage {
  id: string;
  requestId: string;
  placement: "next-turn" | "next-step";
  text: string;
  files?: readonly TimelineInputFile[];
}

export type WebInteraction =
  | { id: string; kind: "approval"; tool: string; prompt: string }
  | { id: string; kind: "question"; questions: PlanQuestion[] }
  | { id: string; kind: "plan"; submitted: SubmittedPlan; callId: string };

export interface WebTurn {
  id: string;
  stopping: boolean;
  entries: WebMessage[];
  delta: string;
  tools: { id: string; name: string }[];
  interaction: WebInteraction | null;
}

export interface WebState {
  workspace: string;
  language: "en" | "zh-CN";
  sessions: WebSession[];
  sessionId: string | null;
  modelId: string | null;
  models: WebModel[];
  timeline: WebMessage[];
  turn: WebTurn | null;
  turns: Readonly<Record<string, Pick<WebTurn, "id" | "stopping" | "interaction">>>;
  error: string | null;
  blocked: boolean;
  planSessions: readonly string[];
  permissionCap: WebPermissionMode;
  inboxes: Readonly<Record<string, readonly WebInboxMessage[]>>;
}

export interface WebSessionActivity {
  sessionId: string | null;
  turn: WebTurn | null;
  timeline: readonly WebMessage[];
}

export type WebEvent = { state: WebState } | { turn: WebTurn };
export type WorkbenchEvent = { state: WebState } | { activity: WebSessionActivity };
