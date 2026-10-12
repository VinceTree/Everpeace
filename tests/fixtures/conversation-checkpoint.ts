/** Reviewed fake-provider output; headings intentionally independent of production constants. */
export function checkpointText(goal = "Fix the requested regression", evidence = "No current verification evidence"): string {
  return [
    "## User Goals and Latest Corrections", `- User requirement: ${goal}`,
    "## Constraints and Decisions", "- Preserve unrelated user work.",
    "## Files and Changes", "- (none)",
    "## Checks and Failure Evidence", `- Tool observation: ${evidence}`,
    "## Unfinished Work", "- Finish the requested repair and host verification.",
    "## Current Progress", "- Model judgment: diagnosis is in progress.",
    "## Next Step", "- Read current files before editing.",
    "## Open Questions", "- (none)",
  ].join("\n");
}
