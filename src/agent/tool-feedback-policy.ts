import { createHash } from "node:crypto";
import type { ToolCall } from "./agent-loop.js";
import { POLICY_DENIED_REMEDY } from "../tools/tool-feedback.js";

export type LoopStrategy = "baseline" | "candidate";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

/** Commit-order feedback, scoped to a task. Stores hashes, never argument bodies. */
export class ToolFeedbackPolicy {
  #previous: string | undefined;
  #count = 0;

  reset(): void { this.#previous = undefined; this.#count = 0; }

  observe(call: ToolCall, output: string, enabled: boolean): { output: string; repeated: boolean } {
    if (call.name === "poll_background") { this.reset(); return { output, repeated: false }; }
    let record: Record<string, unknown>;
    let args: unknown;
    try {
      const value: unknown = JSON.parse(output);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      record = value as Record<string, unknown>;
      try { args = canonical(JSON.parse(call.arguments)); } catch { args = call.arguments; }
    } catch { this.reset(); return { output, repeated: false }; }
    const failure = record.status === "error" || record.status === "denied" || record.status === "rejected" || typeof record.error === "string" || typeof record.exit_code === "number" && record.exit_code !== 0;
    if (!failure || record.cleanup_failed || record.status === "cancelled") { this.reset(); return { output, repeated: false }; }
    const signature = createHash("sha256").update(JSON.stringify([call.name, args, record.status, record.errorCode, record.error ?? record.message, record.exit_code, record.stderr])).digest("hex");
    this.#count = signature === this.#previous ? this.#count + 1 : 1;
    this.#previous = signature;
    const repeated = this.#count === 2;
    if (!enabled) return { output, repeated };
    const before = JSON.stringify(record);
    if (!record.remedy) {
      if (record.status === "denied" || record.status === "rejected") record.remedy = POLICY_DENIED_REMEDY;
      else if (record.errorCode === "FILE_VERSION_CHANGED" || /(?:changed since|read.*first|observed|stale|concurrent)/iu.test(String(record.error))) record.remedy = "Read the current file again before preparing a new edit. Preserve concurrent user changes.";
      else if (/invalid.*argument|argument.*invalid/iu.test(String(record.error))) record.remedy = "Check the advertised parameter schema and correct the arguments before retrying.";
      else if (typeof record.exit_code === "number" && record.exit_code !== 0) record.remedy = "Inspect the command diagnostics and fix the cause before rerunning the relevant check. Preserve the checks.";
    }
    if (repeated) record.retry_notice = "The same call failed twice consecutively. Use its evidence to change the next step; do not blindly repeat it or bypass a denial.";
    const decorated = JSON.stringify(record);
    return { output: decorated === before ? output : decorated, repeated };
  }
}

export const CANDIDATE_SCHEDULING_INSTRUCTIONS = "Call independent reads together in one response. Split operations that depend on a previous result into later responses. After a tool fails, use its error and remedy to change the next step; never replay it blindly or bypass a denial. Retrieve only the relevant output pages.";

export const CANDIDATE_CODING_INSTRUCTIONS = `Carry authorized coding work through implementation, focused checks and change review. Ask only when a missing requirement changes the result or a host permission boundary requires input; existing authorization persists.
Inspect current workspace changes and applicable rules, then read relevant implementation and tests. Search narrowly and expand from evidence. Preserve unrelated staged, unstaged and untracked work; do not reset, overwrite or clean it.
Use update_plan for substantial dependent work and keep it current. Fix failures from actual diagnostics; preserve checks and add regression coverage for changed behavior. Checklist completion does not establish verification.
Use bash for terminal access (PowerShell on Windows, Bash elsewhere), and briefly announce the command's purpose first. Do not use shell for ordinary web access. After timeouts inspect retained output and side effects before choosing a smaller command.
Read current files before editing; prefer apply_patch, or exact replacement for a unique small edit. Verify changes. Before summarizing, review list_workspace_changes and read_workspace_change; review cannot establish ownership or write authority. workspace_status/workspace_diff remain available.
Only the host workflow can settle coding and Goal completion after final verification.`;
