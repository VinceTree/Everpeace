import { createHash } from "node:crypto";
import type { RegisteredModel } from "../storage/model-registry.js";
import { UserSettingsStore } from "../storage/user-settings.js";
import { defaultModelRequestSettings, resolveProviderCapabilities, requestReasoningEffort } from "./capabilities.js";
import type { ProviderRuntime } from "./openai-compatible.js";
import { RequestAttemptLedger } from "../agent/request-attempt-ledger.js";
import { RequestExecutor } from "../agent/request-executor.js";
import type { AgentResponse } from "../agent/react-agent.js";

export type DiagnosticState = "verified" | "configured" | "unsupported" | "not_tested" | "inconclusive";
export type DiagnosticStage = "streaming_text" | "single_tool" | "continuous_tools" | "reasoning" | "usage" | "cancellation";
export interface DiagnosticResult { schema: 1; identity: string; testedAt: string; model: string; endpoint: string; stages: Record<DiagnosticStage, { state: DiagnosticState; detail: string }>; requests: number; inputTokens: number; outputTokens: number; usageComplete: boolean }
export const DOCTOR_LIMITS = { requests: 8, tokenBudget: 20_000, maxOutputTokens: 1024, timeoutMs: 30_000 } as const;
export function diagnosticIdentity(model: RegisteredModel): string {
  return createHash("sha256").update(JSON.stringify({ id: model.id, endpoint: model.base_url, model: model.model_name, profile: model.responses_profile ?? "auto", settings: defaultModelRequestSettings(resolveProviderCapabilities(model.base_url, model.model_name, model.responses_profile), model.request_settings), probe: 1 })).digest("hex");
}
export function diagnosticEndpoint(model: RegisteredModel): string {
  const endpoint = new URL(model.base_url); return `${endpoint.origin}${endpoint.pathname}`;
}
export function diagnosticFreshness(result: DiagnosticResult, model: RegisteredModel, now = Date.now()): "current" | "expired" | "configuration_changed" {
  if (result.identity !== diagnosticIdentity(model)) return "configuration_changed";
  return now - Date.parse(result.testedAt) > 7 * 86400_000 || Date.parse(result.testedAt) > now ? "expired" : "current";
}
function isReports(value: unknown): value is { version: 1; reports: DiagnosticResult[] } {
  if (!value || typeof value !== "object") return false;
  const record = value as { version?: unknown; reports?: unknown };
  return record.version === 1 && Array.isArray(record.reports) && record.reports.every((entry) => entry?.schema === 1 && typeof entry.identity === "string" && /^[a-f0-9]{64}$/u.test(entry.identity) && typeof entry.testedAt === "string" && Number.isFinite(Date.parse(entry.testedAt)) && entry.stages && Object.values(entry.stages).every((stage) => stage && typeof stage === "object" && "state" in stage && ["verified", "configured", "unsupported", "not_tested", "inconclusive"].includes(String(stage.state))));
}
export class DiagnosticStore extends UserSettingsStore<{ version: 1; reports: DiagnosticResult[] }> {
  constructor(filePath?: string) { super("diagnostics.json", isReports, () => ({ version: 1, reports: [] }), filePath); }
  async save(result: DiagnosticResult): Promise<void> { await this.update((current) => ({ version: 1, reports: [...current.reports.filter((entry) => entry.identity !== result.identity), result].slice(-100) })); }
}

/** No shell or file tools are offered. Probe outputs can only call a synthetic echo function. */
export async function runLiveDiagnostics(model: RegisteredModel, runtime: ProviderRuntime, options: { signal?: AbortSignal; now?: () => Date; observe?: <T extends { usage?: unknown; status?: unknown }>(run: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) => Promise<T> } = {}): Promise<DiagnosticResult> {
  const ledger = new RequestAttemptLedger({ tokenBudget: DOCTOR_LIMITS.tokenBudget });
  const executor = new RequestExecutor(ledger);
  const stages = Object.fromEntries((["streaming_text", "single_tool", "continuous_tools", "reasoning", "usage", "cancellation"] as DiagnosticStage[]).map((stage) => [stage, { state: "not_tested", detail: "No protocol evidence collected" }])) as DiagnosticResult["stages"];
  let requests = 0; let observedReasoning = false; let active: DiagnosticStage = "streaming_text";
  const input: Array<Record<string, unknown>> = [{ role: "user", content: "Protocol diagnostic: return OK. Only diagnostic_echo is allowed." }];
  const tool = { type: "function", name: "diagnostic_echo", description: "Echo the diagnostic nonce", parameters: { type: "object", properties: { nonce: { type: "string", enum: ["probe"] } }, required: ["nonce"], additionalProperties: false }, strict: true };
  const effort = requestReasoningEffort(runtime.capabilities, runtime.settings.reasoningEffort);
  async function request(mode: "text" | "tool" | "cancel"): Promise<AgentResponse & { streamed: boolean; cancelled?: boolean }> {
    options.signal?.throwIfAborted();
    const estimatedInput = Math.ceil(Buffer.byteLength(JSON.stringify(input)) / 3) + 512;
    if (requests >= DOCTOR_LIMITS.requests || !ledger.usageComplete || (ledger.remainingTokens ?? 0) < estimatedInput + DOCTOR_LIMITS.maxOutputTokens) throw new Error("Diagnostic admission stopped");
    requests++;
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(DOCTOR_LIMITS.timeoutMs);
    const signal = AbortSignal.any([controller.signal, timeout, ...(options.signal ? [options.signal] : [])]);
    const params = { model: model.model_name, instructions: "Run the bounded protocol probe. Never execute other tools.", input, store: false, max_output_tokens: DOCTOR_LIMITS.maxOutputTokens, ...(effort ? { reasoning: { effort } } : {}), tools: [tool], tool_choice: mode === "tool" ? { type: "function", name: "diagnostic_echo" } : "none" };
    const run = async (): Promise<AgentResponse & { streamed: boolean; cancelled?: boolean }> => {
      const stream = await runtime.responses.stream(params, { signal, maxRetries: 0, timeout: DOCTOR_LIMITS.timeoutMs });
      let final: AgentResponse | undefined; let streamed = false; let sawEvent = false; let cancelled = false;
      try {
        for await (const event of stream) {
          sawEvent = true;
          if (event.type === "response.output_text.delta" && typeof event.delta === "string" && event.delta.length) streamed = true;
          if (String(event.type).includes("reasoning")) observedReasoning = true;
          if (event.type === "response.completed" && event.response && typeof event.response === "object") final = event.response as AgentResponse;
          if (mode === "cancel") { controller.abort(); break; }
        }
      } catch {
        if (mode !== "cancel" || !controller.signal.aborted || !sawEvent || options.signal?.aborted) throw new Error("Diagnostic transport failed");
        cancelled = true;
      }
      if (mode === "cancel" && sawEvent && controller.signal.aborted) return { id: "cancel-probe", status: "completed", output_text: "", output: [], streamed, cancelled: true };
      if (!final || final.status !== "completed") throw new Error("Diagnostic response did not complete");
      if (final.output.some((item) => item.type === "reasoning")) observedReasoning = true;
      const output_text = final.output_text || final.output.filter((item) => item.type === "message").flatMap((item) => Array.isArray(item.content) ? item.content : []).filter((item) => item?.type === "output_text" && typeof item.text === "string").map((item) => item.text).join("");
      return { ...final, output_text, streamed, ...(cancelled ? { cancelled } : {}) };
    };
    return executor.execute("doctor", () => options.observe ? options.observe(run, signal) : run());
  }
  try {
    const text = await request("text");
    stages.streaming_text = { state: text.streamed && Boolean(text.output_text?.trim()) ? "verified" : "inconclusive", detail: "Streaming delta and completed response checked" };
    if (!ledger.usageComplete) throw new Error("Usage unavailable; remaining probes not started");
    active = "single_tool";
    const single = await request("tool");
    function echo(response: AgentResponse): void {
      const calls = response.output.filter((item) => item.type === "function_call");
      if (calls.length !== 1 || calls[0]?.name !== "diagnostic_echo" || typeof calls[0]?.call_id !== "string" || !calls[0].call_id || typeof calls[0]?.arguments !== "string") throw new Error("Synthetic tool protocol evidence missing");
      const args: unknown = JSON.parse(calls[0].arguments);
      if (!args || typeof args !== "object" || Array.isArray(args) || !("nonce" in args) || args.nonce !== "probe" || Object.keys(args).length !== 1) throw new Error("Synthetic tool arguments do not match the offered schema");
      input.push(...response.output, { type: "function_call_output", call_id: calls[0].call_id, output: '{"nonce":"probe"}' });
    }
    echo(single); stages.single_tool = { state: "verified", detail: "Streamed function call with valid arguments" };
    if (!ledger.usageComplete) throw new Error("Usage unavailable; remaining probes not started");
    active = "continuous_tools";
    const second = await request("tool"); echo(second);
    if (!ledger.usageComplete) throw new Error("Usage unavailable; remaining probes not started");
    const finish = await request("text");
    stages.continuous_tools = { state: finish.output_text?.trim() ? "verified" : "inconclusive", detail: "Two consecutive function exchanges and final response checked" };
    if (!ledger.usageComplete) throw new Error("Usage unavailable; remaining probes not started");
    active = "cancellation";
    const cancel = await request("cancel");
    stages.cancellation = { state: cancel.cancelled ? "verified" : "inconclusive", detail: "Local stream abort and iterator cleanup completed; provider-side billing cancellation is not proved" };
  } catch (error) {
    // Only explicit structured protocol rejection is evidence of unsupported capability.
    if (error && typeof error === "object" && "status" in error && [400, 422].includes(Number(error.status)) && "code" in error && ["unsupported_parameter", "unsupported_feature"].includes(String(error.code)) && "param" in error) {
      const rejected: DiagnosticStage[] = error.param === "tools" || error.param === "tool_choice" ? ["single_tool", "continuous_tools"] : error.param === "reasoning" || error.param === "reasoning.effort" ? ["reasoning"] : error.param === "stream" ? [active] : [];
      for (const stage of rejected) if (stages[stage].state !== "verified") stages[stage] = { state: "unsupported", detail: "Endpoint explicitly rejected this protocol capability" };
    }
    if (stages[active].state !== "verified" && stages[active].state !== "unsupported") stages[active] = { state: "inconclusive", detail: options.signal?.aborted ? "User cancelled" : "Missing evidence, transport failure, or request/usage budget stopped probing" };
  }
  const settled = ledger.snapshot();
  if (stages.reasoning.state !== "unsupported" || observedReasoning) stages.reasoning = { state: observedReasoning ? "verified" : model.responses_profile ? "configured" : "not_tested", detail: observedReasoning ? "Reasoning field or event observed; content not retained" : "No reasoning evidence; configured profile is only an assumption" };
  const beforeCancel = settled.attempts.filter((attempt) => attempt.id < (stages.cancellation.state === "verified" ? settled.attempts.length : Infinity));
  stages.usage = { state: beforeCancel.length && beforeCancel.every((attempt) => attempt.usage !== null) ? "verified" : "inconclusive", detail: "Per-request usage checked; cancelled request usage may be unknown" };
  return { schema: 1, identity: diagnosticIdentity(model), testedAt: (options.now?.() ?? new Date()).toISOString(), model: model.model_name, endpoint: diagnosticEndpoint(model), stages, requests, inputTokens: settled.inputTokens, outputTokens: settled.outputTokens, usageComplete: settled.complete };
}
