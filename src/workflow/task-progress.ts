export type TaskStepStatus = "pending" | "in_progress" | "completed";

export interface TaskProgressItem {
  step: string;
  status: TaskStepStatus;
}

export interface TaskProgress {
  plan: TaskProgressItem[];
  updated_at: string;
  /** Present only on a fork until the model replaces the inherited checklist. */
  inherited_from_session_id?: string;
}

export const taskProgressLimits = {
  maxItems: 20,
  maxStepCharacters: 240,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTaskStepStatus(value: unknown): value is TaskStepStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

export function isTaskProgress(value: unknown): value is TaskProgress {
  if (!isRecord(value) || typeof value.updated_at !== "string" || !Array.isArray(value.plan)) return false;
  if (value.inherited_from_session_id !== undefined
    && (typeof value.inherited_from_session_id !== "string"
      || !/^[A-Za-z0-9_-]+$/u.test(value.inherited_from_session_id))) return false;
  if (value.plan.length > taskProgressLimits.maxItems) return false;
  const steps = new Set<string>();
  let active = 0;
  for (const raw of value.plan) {
    if (!isRecord(raw) || Object.keys(raw).some((key) => key !== "step" && key !== "status")) return false;
    if (typeof raw.step !== "string" || !raw.step.trim() || [...raw.step.trim()].length > taskProgressLimits.maxStepCharacters || !isTaskStepStatus(raw.status)) return false;
    const step = raw.step.trim();
    if (steps.has(step)) return false;
    steps.add(step);
    if (raw.status === "in_progress") active += 1;
  }
  return active <= 1;
}

export function cloneTaskProgress(progress: TaskProgress): TaskProgress {
  return {
    plan: progress.plan.map((item) => ({ ...item })),
    updated_at: progress.updated_at,
    ...(progress.inherited_from_session_id === undefined
      ? {}
      : { inherited_from_session_id: progress.inherited_from_session_id }),
  };
}

export function parseTaskProgressArguments(argumentsJson: string, now = new Date()): TaskProgress {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    throw new Error("update_plan arguments must be valid JSON");
  }
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => key !== "plan") || !Array.isArray(parsed.plan)) {
    throw new Error("update_plan requires exactly one plan array");
  }
  const progress: TaskProgress = {
    plan: parsed.plan.map((raw) => {
      if (!isRecord(raw) || Object.keys(raw).some((key) => key !== "step" && key !== "status")) {
        throw new Error("Each plan item requires only step and status");
      }
      const step = typeof raw.step === "string" ? raw.step.trim() : "";
      if (!step) throw new Error("Plan steps must be non-empty strings");
      if ([...step].length > taskProgressLimits.maxStepCharacters) {
        throw new Error(`Plan steps must be at most ${taskProgressLimits.maxStepCharacters} characters`);
      }
      if (!isTaskStepStatus(raw.status)) throw new Error("Plan status must be pending, in_progress, or completed");
      return { step, status: raw.status };
    }),
    updated_at: now.toISOString(),
  };
  if (progress.plan.length > taskProgressLimits.maxItems) {
    throw new Error(`A plan may contain at most ${taskProgressLimits.maxItems} steps`);
  }
  const unique = new Set(progress.plan.map((item) => item.step));
  if (unique.size !== progress.plan.length) throw new Error("Plan steps must be unique");
  if (progress.plan.filter((item) => item.status === "in_progress").length > 1) {
    throw new Error("At most one plan step may be in_progress");
  }
  return progress;
}

export function formatTaskProgress(progress: TaskProgress): string {
  if (progress.plan.length === 0) return "Current task checklist: empty.";
  return [
    `Current task checklist (model-authored, host-persisted${progress.inherited_from_session_id ? `; inherited from Session ${progress.inherited_from_session_id}` : ""}; it does not determine verification):`,
    ...progress.plan.map((item, index) => `${index + 1}. [${item.status}] ${item.step}`),
  ].join("\n");
}

export const UPDATE_PLAN_TOOL_DEFINITION = {
  type: "function" as const,
  name: "update_plan",
  description: "Replace the current coding task checklist. This is progress reporting only; the host still decides whether work is verified.",
  parameters: {
    type: "object",
    properties: {
      plan: {
        type: "array",
        maxItems: taskProgressLimits.maxItems,
        items: {
          type: "object",
          properties: {
            step: { type: "string", maxLength: taskProgressLimits.maxStepCharacters },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["step", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["plan"],
    additionalProperties: false,
  },
  strict: true,
} as const;
