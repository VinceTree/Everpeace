/** Stable machine identifiers. Human explanations are deliberately separate. */
export const EXEC_ERROR_CODES = [
  "CONFIGURATION_ERROR", "RUNTIME_ERROR", "VERIFICATION_FAILED", "LIMIT_REACHED",
  "INTERACTION_REQUIRED", "CANCELLED", "OUTPUT_CLOSED", "PERSISTENCE_FAILED", "CLEANUP_FAILED",
] as const;
export type ExecErrorCode = typeof EXEC_ERROR_CODES[number];
export function isExecErrorCode(value: unknown): value is ExecErrorCode {
  return typeof value === "string" && (EXEC_ERROR_CODES as readonly string[]).includes(value);
}
export function execErrorCode(classification: string, status = classification): ExecErrorCode | undefined {
  if (status === "cleanup_failed") return "CLEANUP_FAILED";
  if (status === "persistence_failed") return "PERSISTENCE_FAILED";
  if (status === "output_closed") return "OUTPUT_CLOSED";
  const codes: Record<string, ExecErrorCode> = {
    configuration_error: "CONFIGURATION_ERROR", runtime_error: "RUNTIME_ERROR", verification_failed: "VERIFICATION_FAILED",
    limit_reached: "LIMIT_REACHED", interaction_required: "INTERACTION_REQUIRED", cancelled: "CANCELLED",
  };
  return codes[classification];
}
