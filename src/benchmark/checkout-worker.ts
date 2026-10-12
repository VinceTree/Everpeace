import { pathToFileURL } from "node:url";
import { RequestAttemptLedger } from "../agent/request-attempt-ledger.js";
import type { RegisteredModel } from "../storage/model-registry.js";
import type { BenchmarkHarnessAdapter, BenchmarkHarnessResult, BenchmarkTask } from "./types.js";
import { projectBenchmarkEvent } from "./event-projection.js";
import type { LoopStrategy } from "../agent/tool-feedback-policy.js";
import type { TeamOptions } from "../team/types.js";

interface CheckoutWorkerInput {
  mode?: "run" | "preflight";
  productionModule: string;
  task?: BenchmarkTask;
  tokenBudget?: number;
  sessionsRoot: string;
  model?: RegisteredModel;
  loopStrategy?: LoopStrategy;
  repairStrategy?: "baseline" | "candidate";
  team?: TeamOptions;
}

interface PreflightBoundaryEvidence {
  providerBoundaryObserved: boolean;
  requests: number;
  model: string;
  reasoning: string;
  maxOutputTokens: number;
  memberRequests: number;
}

async function input(): Promise<CheckoutWorkerInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as CheckoutWorkerInput;
}

function usage(ledger: RequestAttemptLedger): NonNullable<BenchmarkHarnessResult["usage"]> {
  const snapshot = ledger.snapshot();
  return {
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    reasoningTokens: snapshot.reasoningTokens,
    complete: snapshot.complete,
  };
}

function installPreflightProviderBoundary(expectedModel: string, team?: TeamOptions): { evidence(): PreflightBoundaryEvidence } {
  let requests = 0;
  let rootRequests = 0; let memberRequests = 0;
  const members = team?.enabled !== false && team ? (team.maxAgents ?? 3) - 1 : 0;
  let observed: PreflightBoundaryEvidence | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests += 1;
    let bodyText = typeof init?.body === "string"
      ? init.body
      : init?.body instanceof Uint8Array
        ? Buffer.from(init.body).toString("utf8")
        : "";
    if (!bodyText && typeof Request !== "undefined" && _input instanceof Request) bodyText = await _input.clone().text();
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    const root = Array.isArray(body.tools) && body.tools.some((tool: { name?: string }) => tool.name === "spawn_agent");
    if (root) rootRequests++; else if (members) memberRequests++;
    const reasoning = body.reasoning && typeof body.reasoning === "object"
      ? (body.reasoning as Record<string, unknown>).effort
      : undefined;
    if (body.model !== expectedModel || reasoning !== "high" || body.max_output_tokens !== 32_768 || body.stream !== true) {
      throw new Error(`Checkout preflight request settings mismatch: ${JSON.stringify({ model: body.model, reasoning, maxOutputTokens: body.max_output_tokens, stream: body.stream })}`);
    }
    observed = {
      providerBoundaryObserved: true,
      requests,
      model: expectedModel,
      reasoning: "high",
      maxOutputTokens: 32_768,
      memberRequests,
    };
    const output = root && members && rootRequests === 1
      ? Array.from({ length: members }, (_, index) => ({ type: "function_call", id: `fc_preflight_${index}`, call_id: `call_preflight_${index}`, name: "spawn_agent", arguments: JSON.stringify({ role: index ? "reviewer" : "explorer", goal: "Read-only offline preflight acknowledgement", acceptance: "Return an acknowledgement without tools", paths: ["."], dependencies: [] }) }))
      : root && members && rootRequests === 2
        ? [{ type: "function_call", id: "fc_wait", call_id: "call_wait", name: "wait_agents", arguments: JSON.stringify({ timeout_ms: 1000 }) }]
        : [{ id: `msg_preflight_${requests}`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Preflight complete.", annotations: [] }] }];
    const response = {
      id: "resp_preflight",
      object: "response",
      created_at: 0,
      status: "completed",
      error: null,
      incomplete_details: null,
      model: expectedModel,
      output_text: "Preflight complete.",
      output,
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 2,
      },
    };
    const stream = `data: ${JSON.stringify({ type: "response.completed", response })}\n\ndata: [DONE]\n\n`;
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  return {
    evidence() {
      if (!observed || (members ? memberRequests !== members || requests < members + 3 : requests !== 1)) throw new Error("Checkout preflight did not observe the expected root/member request boundaries");
      return { ...observed, requests, memberRequests };
    },
  };
}

export async function main(): Promise<void> {
  const request = await input();
  const preflightBoundary = request.mode === "preflight" && request.model
    ? installPreflightProviderBoundary(request.model.model_name, request.team)
    : undefined;
  const module = await import(request.productionModule) as {
    createProductionBenchmarkAdapter?: (options: { model: RegisteredModel; sessionsRoot: string; loopStrategy?: LoopStrategy; team?: TeamOptions; repairStrategy?: "baseline" | "candidate" }) => BenchmarkHarnessAdapter;
  };
  if (typeof module.createProductionBenchmarkAdapter !== "function") throw new Error("Checkout production module does not export createProductionBenchmarkAdapter");
  if (!request.model || !request.task || !request.sessionsRoot) throw new Error("Checkout worker run input is incomplete");
  if (request.model.request_settings?.reasoningEffort !== "high" || request.model.request_settings.maxOutputTokens !== 32_768) {
    throw new Error("Checkout benchmark requires high reasoning and 32768 output tokens");
  }
  const ledger = new RequestAttemptLedger((request.tokenBudget === undefined ? {} : { tokenBudget: request.tokenBudget }));
  const adapter = module.createProductionBenchmarkAdapter({ model: request.model, sessionsRoot: request.sessionsRoot, ...(request.loopStrategy === undefined ? {} : { loopStrategy: request.loopStrategy }), ...(request.team ? { team: request.team } : {}), ...(request.repairStrategy === undefined ? {} : { repairStrategy: request.repairStrategy }) });
  const controller = new AbortController();
  const result = await adapter.run(request.task, {
    task: request.task,
    signal: controller.signal,
    attempt: 1,
    phase: "implement",
    ...(request.tokenBudget === undefined ? {} : { tokenBudgetRemaining: request.tokenBudget }),
    requestAttemptLedger: ledger,
    onPhase(phase) { if (request.mode !== "preflight") process.stdout.write(`EVERPEACE_CHECKOUT_PHASE ${phase}\n`); },
    onEvent(event) {
      const projected = projectBenchmarkEvent(event);
      if (projected && request.mode !== "preflight") process.stdout.write(`EVERPEACE_CHECKOUT_EVENT ${JSON.stringify(projected)}\n`);
    },
  });
  if (request.mode === "preflight") {
    const evidence = preflightBoundary!.evidence();
    const ledgerSnapshot = ledger.snapshot();
    if (!ledgerSnapshot.complete || ledgerSnapshot.attempts.filter((attempt) => attempt.status !== "rejected").length !== evidence.requests || ledgerSnapshot.inputTokens !== evidence.requests || ledgerSnapshot.outputTokens !== evidence.requests) throw new Error("Checkout preflight root/member request accounting is incomplete");
    process.stdout.write(`EVERPEACE_CHECKOUT_PREFLIGHT ${JSON.stringify({
      ...evidence,
      usage: usage(ledger),
      ...(result?.terminalOutcome ? { terminalOutcome: result.terminalOutcome } : {}),
    })}\n`);
    return;
  }
  process.stdout.write(`EVERPEACE_CHECKOUT_RESULT ${JSON.stringify({ ...result, usage: { ...result?.usage, ...usage(ledger) } })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
