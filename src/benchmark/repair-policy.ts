import { createHash } from "node:crypto";
import type { WorkflowState } from "../workflow/types.js";

/** Evaluation-only decision; it can stop repairs, never raise the production cap. */
export class CandidateRepairPolicy {
  #last: { diagnostic: string; revision: string } | undefined;
  decision(state: WorkflowState): string | undefined {
    const failed = state.last_verification_suite?.results.find((result) => !result.passed) ?? state.last_verification;
    if (!failed) return;
    if (failed.error && /ENOENT|EACCES|POLICY_DENIED|SANDBOX_UNAVAILABLE|not approved|permission|authorization|executable|spawn/iu.test(failed.error)) return "Evaluation policy stopped an environment or authorization failure";
    const limit = ["typecheck", "lint"].includes(failed.command.id.split(":").at(-1)!) ? 2 : 3;
    if (state.repair_attempts >= limit) return "Evaluation policy repair allocation reached";
    const diagnostic = createHash("sha256").update(JSON.stringify([failed.command.id, failed.exitCode, failed.error, failed.stdout, failed.stderr])).digest("hex");
    if (state.workspace_revision && this.#last?.revision === state.workspace_revision && this.#last.diagnostic === diagnostic) return "Evaluation policy stopped an unchanged repeated diagnostic";
    this.#last = state.workspace_revision ? { diagnostic, revision: state.workspace_revision } : undefined;
  }
}
