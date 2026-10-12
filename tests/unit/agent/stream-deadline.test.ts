import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResponseStreamConsumer } from '../../../src/agent/response-stream-consumer.js';
import { ModelStreamCleanupError, ModelStreamCancelledError } from '../../../src/agent/response-errors.js';
import { RequestExecutor } from '../../../src/agent/request-executor.js';
import { RequestAttemptLedger } from '../../../src/agent/request-attempt-ledger.js';
import { ownResponseStream } from '../../../src/providers/response-stream.js';
import OpenAI from 'openai';

const never = () => new Promise<never>(() => {});
for (const hanging of ['return', 'next'] as const) {
  test(`stream ${hanging} cleanup is bounded`, { timeout: 1500 }, async () => {
    const consumer = new ResponseStreamConsumer({ recovery: false, recoveryCacheMaxBytes: 0, idleTimeoutMs: 10, cleanupTimeoutMs: 30 });
    const stream = { [Symbol.asyncIterator]() { return { next: never, return: hanging === 'return' ? never : async () => ({ done: true as const, value: undefined }) }; } };
    const started = performance.now();
    await assert.rejects(consumer.consume(stream, () => {}, () => {}), ModelStreamCleanupError);
    assert.ok(performance.now() - started < 1000);
    assert.ok(consumer.failure instanceof ModelStreamCleanupError);
  });
}
test('cancel bypasses idle timeout and cannot publish a late event', { timeout: 1500 }, async () => {
  const controller = new AbortController(); let emit!: (value: IteratorResult<Record<string, unknown>>) => void, events = 0;
  const pending = new Promise<IteratorResult<Record<string, unknown>>>(resolve => { emit = resolve; });
  const stream = { [Symbol.asyncIterator]() { return { next: () => pending, return: never }; } };
  const consumer = new ResponseStreamConsumer({ recovery: false, recoveryCacheMaxBytes: 0, idleTimeoutMs: 60000, cleanupTimeoutMs: 30 });
  const result = consumer.consume(stream, () => { events++; }, () => {}, controller.signal);
  controller.abort(); await assert.rejects(result, ModelStreamCleanupError);
  emit({ done: false, value: { type: 'response.output_text.delta', delta: 'late' } });
  await Promise.resolve(); assert.equal(events, 0);
});
test('production body cancellation uses the consumer deadline', { timeout: 1500 }, async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({ cancel: never });
  const stream = ownResponseStream(new Response(body, { headers: { 'content-type': 'text/event-stream' } }), controller, controller.signal, new OpenAI({ apiKey: 'offline' }));
  stream.cleanupDeadline!(30);
  const consumer = new ResponseStreamConsumer({ recovery: false, recoveryCacheMaxBytes: 0, idleTimeoutMs: 10, cleanupTimeoutMs: 30 });
  await assert.rejects(consumer.consume(stream, () => {}, () => controller.abort()), ModelStreamCleanupError);
});
test('cancellation discards late output but bills a reliable terminal sample exactly once', async () => {
  const controller = new AbortController(); let outputs = 0;
  const stream = { [Symbol.asyncIterator]() { return {
    async next() { controller.abort(); return { done: false as const, value: { type: 'response.completed', response: { id: 'late', output: [], output_text: 'must not publish', usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } } }; },
    async return() { return { done: true as const, value: undefined }; },
  }; } };
  const consumer = new ResponseStreamConsumer({ recovery: false, recoveryCacheMaxBytes: 0, idleTimeoutMs: 60000, writeAssistantDelta: () => { outputs++; } });
  const ledger = new RequestAttemptLedger({ tokenBudget: 100 }), executor = new RequestExecutor(ledger);
  await assert.rejects(executor.execute('coding', () => consumer.consume(stream, () => { outputs++; }, () => {}, controller.signal)), ModelStreamCancelledError);
  assert.equal(outputs, 0); assert.equal(consumer.failure, undefined); assert.equal(ledger.snapshot().complete, true); assert.equal(ledger.snapshot().remainingTokens, 97); assert.equal(ledger.snapshot().attempts.length, 1);
});
