export type DiagnosticCategory = "configuration" | "protocol" | "dependency" | "sandbox" | "usage" | "verification" | "environment" | "tool";
/** Classify host-known fields; raw provider/exception bodies never become diagnostics. */
export function diagnosticCategory(code: string): DiagnosticCategory {
  code = code.toUpperCase();
  if (/MODEL|CONFIG|ARGUMENT/u.test(code)) return "configuration";
  if (/PROTOCOL|RESPONSE|STREAM/u.test(code)) return "protocol";
  if (/DEPENDENCY|NOT_FOUND|UNAVAILABLE_BINARY/u.test(code)) return "dependency";
  if (/SANDBOX|POLICY|PERMISSION/u.test(code)) return "sandbox";
  if (/USAGE|BUDGET/u.test(code)) return "usage";
  if (/VERIFICATION|CHECK_FAILED/u.test(code)) return "verification";
  if (/COMMAND|TIMEOUT|PROCESS/u.test(code)) return "environment";
  return "tool";
}

export function decorateToolDiagnostic(output: string): string {
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return output;
    if (!["error", "denied", "rejected", "failed"].includes(String(value.status)) && typeof value.error !== "string" && !(typeof value.exit_code === "number" && value.exit_code !== 0)) return output;
    const code = typeof value.errorCode === "string" ? value.errorCode : typeof value.exit_code === "number" ? "COMMAND_FAILED" : "TOOL_FAILED";
    return JSON.stringify({ ...value, diagnosticCategory: diagnosticCategory(code) });
  } catch { return output; }
}
