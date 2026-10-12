import type { AgentResponse, ResponseStreamLike, ResponseRecoveryState, ResponsesClientLike, ResponsesRequestOptions } from './model-protocol.js';
import type { LoopEvent } from './agent-loop.js';
import { ResponseStreamConsumer } from './response-stream-consumer.js';
import { ResourceCleanupError } from '../util/resource-cleanup-error.js';
import { PersistenceError } from '../storage/persistence-error.js';
import { LoopStoppedError } from './agent-loop.js';
import { ResponseStreamIncompleteError, ModelResponseError, isStreamUnsupportedError } from './response-errors.js';
function isResponseStream(value: AgentResponse | ResponseStreamLike): value is ResponseStreamLike { return typeof value === 'object' && value !== null && Symbol.asyncIterator in value; }
export interface CodingTransportHost { prepare(): Promise<Record<string, unknown>>; execute(run: () => Promise<AgentResponse>): Promise<AgentResponse>; }
/** Transport mode, stream assembly and bounded resume belong to one request owner. */
export class ModelRequestRuntime {
  constructor(readonly client: ResponsesClientLike, readonly streams: ResponseStreamConsumer, public transport: 'stream' | 'buffered', readonly event: ((event: LoopEvent) => void) | undefined) {}
  async create(options: ResponsesRequestOptions, signal: AbortSignal | undefined, recoveryBudget: { remaining: number }, host: CodingTransportHost): Promise<AgentResponse> {
    this.event?.({ type: "sampling_started" });
    if (this.transport === "stream" && this.client.responses.stream) {
      let eventsSeen = 0;
      const consumeStreamAttempt = async (
        open: (attemptOptions: ResponsesRequestOptions) => Promise<ResponseStreamLike> | ResponseStreamLike,
      ): Promise<AgentResponse> => {
        const transportController = new AbortController();
        const attemptSignal = signal
          ? AbortSignal.any([signal, transportController.signal])
          : transportController.signal;
        try {
          return await this.streams.consume(
            await open({ ...options, signal: attemptSignal }),
            async () => { eventsSeen += 1; },
            () => transportController.abort(new Error("Model stream closed by host")),
          );
        } finally {
          if (!transportController.signal.aborted) transportController.abort(new Error("Model stream settled"));
        }
      };
      try {
        try {
          return await host.execute(async () => {
              const params = await host.prepare();
              return consumeStreamAttempt((attemptOptions) => this.client.responses.stream!(params, attemptOptions));
            },
          );
        } catch (error) {
          if (error instanceof ResourceCleanupError || error instanceof PersistenceError || error instanceof LoopStoppedError) throw error;
          const adapter = this.client.responses.recovery;
          const state = error instanceof ResponseStreamIncompleteError
            ? (error as ResponseStreamIncompleteError & { recoveryState?: ResponseRecoveryState }).recoveryState
            : undefined;
          if (!signal?.aborted && adapter && state && recoveryBudget.remaining > 0) {
            recoveryBudget.remaining -= 1;
            this.event?.({ type: "stream_recovery_started" });
            try {
              const result = await host.execute(async () => {
                const params = await host.prepare();
                const recoveryController = new AbortController();
                const recoverySignal = signal
                  ? AbortSignal.any([signal, recoveryController.signal])
                  : recoveryController.signal;
                try {
                  const recovered = await adapter.resume(params, state, { ...options, signal: recoverySignal });
                  return isResponseStream(recovered)
                    ? await this.streams.consume(
                        recovered,
                        async () => { eventsSeen += 1; },
                        () => recoveryController.abort(new Error("Recovered model stream closed by host")),
                      )
                    : recovered;
                } finally {
                  if (!recoveryController.signal.aborted) recoveryController.abort(new Error("Recovered model request settled"));
                }
              });
              if (result.status && result.status !== "completed") throw new ModelResponseError(result);
              this.event?.({ type: "stream_recovery_finished" });
              return result;
            } catch (recoveryError) {
              if (recoveryError instanceof ResourceCleanupError || recoveryError instanceof PersistenceError || recoveryError instanceof LoopStoppedError) throw recoveryError;
              this.event?.({ type: "stream_recovery_finished", success: false });
              throw error;
            }
          }
          throw error;
        }
      } catch (error) {
        if (error instanceof ResourceCleanupError || error instanceof PersistenceError || error instanceof LoopStoppedError) throw error;
        if (signal?.aborted) throw error;
        if (eventsSeen === 0 && isStreamUnsupportedError(error)) {
          this.transport = "buffered";
          this.event?.({ type: "sampling_started" });
          return host.execute(async () => {
            const params = await host.prepare();
            return this.client.responses.create(params, options);
          });
        }
        throw error;
      }
    }
    return host.execute(async () => {
      const params = await host.prepare();
      return this.client.responses.create(params, options);
    });
  }
}
