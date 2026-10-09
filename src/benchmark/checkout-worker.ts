import { pathToFileURL } from "node:url";
import { RequestAttemptLedger } from "../agent/request-attempt-ledger.js";
import type { RegisteredModel } from "../storage/model-registry.js";
import type { BenchmarkHarnessAdapter, BenchmarkHarnessResult, BenchmarkTask } from "./types.js";
import { projectBenchmarkEvent } from "./event-projection.js";
import type { LoopStrategy } from "../agent/tool-feedback-policy.js";

interface CheckoutWorkerInput {
  mode?: "run" | "preflight";
  productionModule: string;
  task?: BenchmarkTask;
  tokenBudget?: number;
  sessionsRoot: string;
  model?: RegisteredModel;
  loopStrategy?: LoopStrategy;
}

interface PreflightBoundaryEvidence {
  providerBoundaryObserved: boolean;
  requests: number;
  model: string;
  reasoning: string;
  maxOutputTokens: number;
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

function installPreflightProviderBoundary(expectedModel: string): { evidence(): PreflightBoundaryEvidence } {
  let requests = 0;
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
    };
    const response = {
      id: "resp_preflight",
      object: "response",
      created_at: 0,
      status: "completed",
      error: null,
      incomplete_details: null,
      model: expectedModel,
      output_text: "Preflight complete.",
      output: [{
        id: "msg_preflight",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "Preflight complete.", annotations: [] }],
      }],
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
      if (!observed || requests !== 1) throw new Error(`Checkout preflight expected one provider request, observed ${requests}`);
      return observed;
    },
  };
}

export async function main(): Promise<void> {
  const request = await input();
  const preflightBoundary = request.mode === "preflight" && request.model
    ? installPreflightProviderBoundary(request.model.model_name)
    : undefined;
  const module = await import(request.productionModule) as {
    createProductionBenchmarkAdapter?: (options: { model: RegisteredModel; sessionsRoot: string; loopStrategy?: LoopStrategy }) => BenchmarkHarnessAdapter;
  };
  if (typeof module.createProductionBenchmarkAdapter !== "function") throw new Error("Checkout production module does not export createProductionBenchmarkAdapter");
  if (!request.model || !request.task || !request.sessionsRoot) throw new Error("Checkout worker run input is incomplete");
  if (request.model.request_settings?.reasoningEffort !== "high" || request.model.request_settings.maxOutputTokens !== 32_768) {
    throw new Error("Checkout benchmark requires high reasoning and 32768 output tokens");
  }
  const ledger = new RequestAttemptLedger({ ...(request.tokenBudget === undefined ? {} : { tokenBudget: request.tokenBudget }) });
  const adapter = module.createProductionBenchmarkAdapter({ model: request.model, sessionsRoot: request.sessionsRoot, ...(request.loopStrategy === undefined ? {} : { loopStrategy: request.loopStrategy }) });
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
    if (!ledgerSnapshot.complete || ledgerSnapshot.attempts.length !== 1) throw new Error("Checkout preflight request accounting is incomplete");
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
