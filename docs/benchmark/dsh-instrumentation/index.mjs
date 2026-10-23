import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 1;

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validatedUsage(value) {
  if (!value || !nonNegativeSafeInteger(value.inputTokens) || !nonNegativeSafeInteger(value.outputTokens)) return undefined;
  for (const field of ['reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    if (value[field] !== undefined && !nonNegativeSafeInteger(value[field])) return undefined;
  }
  return value;
}

function statusFromFinish(reason) {
  if (reason?.kind === 'aborted') return 'cancelled';
  if (reason?.kind === 'error') return 'failed';
  return 'completed';
}

export function createInstrumentation(expected, persist = () => {}) {
  const attempts = [];
  const configurationErrors = [];
  let nextId = 1;
  let incomplete = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cachedInputTokens = 0;
  let cacheObservedInputTokens = 0;

  const snapshot = () => {
    const consumedTokens = inputTokens + outputTokens;
    return {
      schemaVersion: SCHEMA_VERSION,
      expected: { ...expected },
      attempts: attempts.map((attempt) => ({ ...attempt, usage: attempt.usage && { ...attempt.usage } })),
      inputTokens,
      outputTokens,
      reasoningTokens,
      cachedInputTokens,
      cacheObservedInputTokens,
      complete: !incomplete && attempts.every((attempt) => attempt.status !== 'active'),
      tokenBudget: expected.tokenBudget,
      remainingTokens: expected.tokenBudget - consumedTokens,
      ...(consumedTokens > expected.tokenBudget ? { exceededBy: consumedTokens - expected.tokenBudget } : {}),
      configurationErrors: [...configurationErrors],
    };
  };

  const save = () => persist(snapshot());

  const reject = (purpose, message) => {
    configurationErrors.push(message);
    attempts.push({ id: nextId++, purpose, status: 'rejected', usage: {
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    } });
    save();
    return (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'BENCHMARK_ADMISSION', message } } };
    })();
  };

  const wrap = (options, next) => {
    const purpose = options.purpose ?? 'coding';
    const errors = [];
    if (options.provider !== expected.provider) errors.push(`provider ${JSON.stringify(options.provider)} != ${JSON.stringify(expected.provider)}`);
    if (options.model !== expected.model) errors.push(`model ${JSON.stringify(options.model)} != ${JSON.stringify(expected.model)}`);
    if (purpose === 'coding') {
      if (String(options.reasoningEffort ?? '') !== expected.reasoning) {
        errors.push(`reasoning ${JSON.stringify(options.reasoningEffort)} != ${JSON.stringify(expected.reasoning)}`);
      }
      if (options.maxTokens !== expected.maxOutputTokens) {
        errors.push(`maxTokens ${JSON.stringify(options.maxTokens)} != ${expected.maxOutputTokens}`);
      }
    }
    if (errors.length > 0) return reject(purpose, `Benchmark request configuration mismatch: ${errors.join('; ')}`);
    if (incomplete) return reject(purpose, 'A prior provider attempt has unknown usage');
    if (snapshot().remainingTokens <= 0) return reject(purpose, 'The task token budget is exhausted');

    const attempt = { id: nextId++, purpose, status: 'active', usage: null };
    attempts.push(attempt);
    save();
    return (async function* () {
      let usage;
      let status = 'failed';
      try {
        if (process.env.EVERPEACE_DSH_PREFLIGHT === '1') {
          yield { type: 'text-delta', index: 0, text: 'Preflight complete.' };
          yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
          yield { type: 'finish', reason: { kind: 'stop' } };
          usage = { inputTokens: 0, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
          status = 'completed';
          return;
        }
        for await (const chunk of next()) {
          if (chunk?.type === 'usage') usage = chunk.usage;
          if (chunk?.type === 'finish') status = statusFromFinish(chunk.reason);
          yield chunk;
        }
      } finally {
        attempt.status = status;
        const validUsage = validatedUsage(usage);
        if (validUsage === undefined) {
          incomplete = true;
          attempt.usage = null;
          attempt.unknownReason = usage == null ? 'missing_usage' : 'invalid_usage';
          configurationErrors.push('Provider has unknown usage: missing or invalid token counts');
        } else {
          const cacheRead = validUsage.cacheReadTokens ?? 0;
          const cacheWrite = validUsage.cacheWriteTokens ?? 0;
          const totalInput = validUsage.inputTokens + cacheRead + cacheWrite;
          attempt.usage = {
            inputTokens: totalInput,
            outputTokens: validUsage.outputTokens,
            reasoningTokens: validUsage.reasoningTokens ?? 0,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
          };
          inputTokens += totalInput;
          outputTokens += validUsage.outputTokens;
          reasoningTokens += validUsage.reasoningTokens ?? 0;
          cachedInputTokens += cacheRead;
          if (validUsage.cacheReadTokens !== undefined && validUsage.cacheWriteTokens !== undefined) cacheObservedInputTokens += totalInput;
          // Overshoot is reported by the aggregate fields; it is not hidden or clamped.
        }
        save();
      }
    })();
  };

  save();
  return { wrap, snapshot };
}

function expectedFromEnvironment() {
  const model = process.env.EVERPEACE_BENCHMARK_MODEL;
  const ledgerPath = process.env.EVERPEACE_DSH_LEDGER_PATH;
  if (!model) throw new Error('EVERPEACE_BENCHMARK_MODEL is required');
  if (!ledgerPath) throw new Error('EVERPEACE_DSH_LEDGER_PATH is required');
  return {
    ledgerPath,
    provider: process.env.EVERPEACE_DSH_PROVIDER ?? 'deepseek-official',
    model,
    reasoning: process.env.EVERPEACE_BENCHMARK_REASONING ?? 'high',
    maxOutputTokens: positiveInteger(process.env.EVERPEACE_BENCHMARK_MAX_OUTPUT_TOKENS, 'EVERPEACE_BENCHMARK_MAX_OUTPUT_TOKENS'),
    tokenBudget: positiveInteger(process.env.EVERPEACE_BENCHMARK_TOKEN_BUDGET, 'EVERPEACE_BENCHMARK_TOKEN_BUDGET'),
  };
}

export const name = 'everpeace-benchmark-instrumentation';
export const inject = ['llm'];

export function apply(ctx) {
  const { ledgerPath, ...expected } = expectedFromEnvironment();
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const instrumentation = createInstrumentation(expected, (value) => {
    const temporary = `${ledgerPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, 'utf8');
    renameSync(temporary, ledgerPath);
  });
  ctx.on('llm/stream', (options, next) => instrumentation.wrap(options, next));
}
