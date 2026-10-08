export class ToolFeedbackError extends Error {
  constructor(readonly code: string, message: string, readonly remedy: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolFeedbackError";
  }
}

export class ToolArgumentError extends ToolFeedbackError {
  constructor(readonly field: string, readonly expected: string) {
    super("INVALID_ARGUMENTS", `Invalid tool argument '${field}': expected ${expected}.`, `Correct '${field}' to ${expected}, then submit the tool call again.`);
    this.name = "ToolArgumentError";
  }
}

export function invalidToolArgument(field: string, expected: string): never {
  throw new ToolArgumentError(field, expected);
}

export function toolFeedbackFields(error: unknown): { errorCode?: string; remedy?: string } {
  return error instanceof ToolFeedbackError ? { errorCode: error.code, remedy: error.remedy } : {};
}

export const POLICY_DENIED_REMEDY = "Respect the current permission policy and user decision. Do not retry through another tool or execution path to bypass the denial.";
export const COMMAND_TIMEOUT_REMEDY = "Inspect the retained output and any side effects before continuing. The command may have partially executed; do not blindly replay it. Use a smaller or more focused command if further execution is needed.";

export function commandFailureFeedback(result: { timedOut?: boolean }): { errorCode?: string; remedy?: string } {
  return result.timedOut ? { errorCode: "COMMAND_TIMEOUT", remedy: COMMAND_TIMEOUT_REMEDY } : {};
}
