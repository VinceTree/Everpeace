import type { WorkflowState } from "./types.js";

/** Only host facts needed by the coding model; never a verification transcript. */
export type WorkflowContext = Pick<WorkflowState,
  "task_source" | "phase" | "result" | "pending_verification" | "tracking_limited" | "repair_attempts" | "max_repair_attempts"
>;

export function projectWorkflowContext(state: WorkflowContext & Pick<WorkflowState, "prior_unverified">): WorkflowContext {
  return {
    ...(state.task_source === undefined ? {} : { task_source: state.task_source }),
    phase: state.phase,
    ...(state.result === undefined ? {} : { result: state.result }),
    ...(state.prior_unverified ? { pending_verification: true } : state.pending_verification === undefined ? {} : { pending_verification: state.pending_verification }),
    ...(state.tracking_limited === undefined ? {} : { tracking_limited: state.tracking_limited }),
    repair_attempts: state.repair_attempts,
    max_repair_attempts: state.max_repair_attempts,
  };
}

export function formatWorkflowContext(context: WorkflowContext | undefined): string {
  return context ? [
    `Current host workflow facts: ${JSON.stringify(context)}`,
    "These facts supersede historical workflow claims in summaries. Missing fields are unknown, not success. Completed checklist steps do not settle verification; only the host runner can settle this task, Goal, and successful Memory capture.",
  ].join("\n") : "";
}
