import { ToolFeedbackError } from '../tools/tool-feedback.js';
export type TeamWorkspaceReason = 'submodule_unsupported' | 'lfs_object_missing' | 'snapshot_incomplete' | 'snapshot_changed' | 'resource_limit';
export class TeamWorkspaceError extends ToolFeedbackError {
  constructor(readonly reason: TeamWorkspaceReason) {
    super(`TEAM_${reason.toUpperCase()}`, `Team workspace refused: ${reason}`, reason === 'lfs_object_missing' ? 'Materialize LFS objects yourself before delegating, or use the root agent on available files. No automatic download was attempted.' : reason === 'submodule_unsupported' ? 'Use the root agent or a separately authorized ordinary repository. Submodules are not automatically initialized.' : reason === 'resource_limit' ? 'Narrow the authorized workspace or task scope; do not bypass resource limits.' : 'Inspect repository completeness and concurrent edits, then take a fresh snapshot. Retained owned materials can be explicitly cleaned.');
  }
}
