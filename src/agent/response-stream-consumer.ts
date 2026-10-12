import type { AgentResponse, ResponseStreamLike, ResponseRecoveryState, AgentIO } from './react-agent.js';
import type { LoopEvent } from './agent-loop.js';
import { ResponseStreamIncompleteError, ModelStreamCleanupError, ModelResponseError } from './response-errors.js';
import { ResourceCleanupError } from '../util/resource-cleanup-error.js';
import { PersistenceError } from '../storage/persistence-error.js';
type ResponseOutputItem = AgentResponse['output'][number];
export interface StreamConsumerOptions {
  recovery: boolean; recoveryCacheMaxBytes: number; idleTimeoutMs: number;
  onEvent?(event: LoopEvent): void;
  writeAssistantDelta?: AgentIO['writeAssistantDelta']; onToolProgress?: AgentIO['onToolProgress'];
}
/** Owns stream assembly, bounded recovery evidence and iterator closure. */
export class ResponseStreamConsumer {
  #failure: ResourceCleanupError | undefined;
  constructor(readonly options: StreamConsumerOptions) {}
  get failure(): ResourceCleanupError | undefined { return this.#failure; }
  async consume(
    stream: ResponseStreamLike,
    onEvent: () => void,
    abortRequest: () => void,
  ): Promise<AgentResponse> {
    let response: AgentResponse | undefined;
    let outputText = "";
    const items = new Map<string, ResponseOutputItem>();
    const events: Array<Record<string, unknown>> = [];
    let eventsSeen = 0;
    let recoveryBytes = 0;
    let retainEvents = this.options.recovery;
    let lastEventId: string | undefined;
    let responseId: string | undefined;
    let reasoningActive = false;
    let firstEventSeen = false;
    let firstTextSeen = false;
    let exhausted = false;
    let pendingNext: Promise<IteratorResult<Record<string, unknown>>> | undefined;
    const iterator = stream[Symbol.asyncIterator]();
    try {
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        pendingNext = Promise.resolve(iterator.next());
        const next = await Promise.race([
          pendingNext,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new ResponseStreamIncompleteError({ cause: new Error(`Model stream was idle for ${this.options.idleTimeoutMs}ms`) })), this.options.idleTimeoutMs);
          }),
        ]).finally(() => { if (timer) clearTimeout(timer); });
        if (next.done) { exhausted = true; break; }
        const event = next.value;
        onEvent();
        if (!firstEventSeen) {
          firstEventSeen = true;
          this.options.onEvent?.({ type: "model_progress", milestone: "first_event" });
        }
        eventsSeen += 1;
        if (retainEvents) {
          recoveryBytes += Buffer.byteLength(JSON.stringify(event), "utf8");
          if (recoveryBytes <= this.options.recoveryCacheMaxBytes) events.push(event);
          else { retainEvents = false; events.length = 0; }
        }
        if (typeof event.id === "string") lastEventId = event.id;
        if (event.response && typeof event.response === "object" && typeof (event.response as Record<string, unknown>).id === "string") {
          responseId = (event.response as Record<string, unknown>).id as string;
        }
        const type = event.type;
        if ((type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta") && typeof event.delta === "string") {
          if (!reasoningActive) {
            reasoningActive = true;
            this.options.onEvent?.({ type: "reasoning_started" });
          }
        } else if (type === "response.output_text.delta" && typeof event.delta === "string") {
          if (!firstTextSeen && event.delta.length > 0) {
            firstTextSeen = true;
            this.options.onEvent?.({ type: "model_progress", milestone: "first_text" });
          }
          if (reasoningActive) {
            reasoningActive = false;
            this.options.onEvent?.({ type: "reasoning_finished" });
          }
          outputText += event.delta;
          const renderStarted = performance.now();
          try { this.options.writeAssistantDelta?.(event.delta); }
          finally { this.options.onEvent?.({ type: "timing_recorded", operation: "rendering", durationMs: performance.now() - renderStarted }); }
        } else if (type === "response.output_item.added" && event.item && typeof event.item === "object") {
          const item = event.item as ResponseOutputItem;
          const key = typeof event.output_index === "number"
            ? String(event.output_index)
            : item.id ?? item.call_id ?? `${items.size}`;
          items.set(key, { ...item });
          if (item.type === "function_call") {
            this.options.onToolProgress?.({
              phase: "streaming",
              name: typeof item.name === "string" ? item.name : "tool",
              ...(typeof item.arguments === "string" ? { detail: item.arguments } : {}),
            });
          }
        } else if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
          const key = typeof event.output_index === "number"
            ? String(event.output_index)
            : typeof event.item_id === "string" ? event.item_id : "";
          const item = items.get(key);
          if (item) {
            item.arguments = `${item.arguments ?? ""}${event.delta}`;
            this.options.onToolProgress?.({
              phase: "streaming",
              name: typeof item.name === "string" ? item.name : "tool",
              detail: item.arguments,
            });
          }
        } else if (type === "response.output_item.done" && event.item && typeof event.item === "object") {
          const item = event.item as ResponseOutputItem;
          const key = typeof event.output_index === "number"
            ? String(event.output_index)
            : item.id ?? item.call_id ?? `${items.size}`;
          items.set(key, { ...item });
      } else if (type === "response.completed" && event.response && typeof event.response === "object") {
        response = event.response as AgentResponse;
        break;
      } else if (type === "response.failed" || type === "response.incomplete") {
        const failedResponse = event.response && typeof event.response === "object"
          ? event.response as Record<string, unknown>
            : undefined;
          response = {
            id: typeof failedResponse?.id === "string" ? failedResponse.id : "stream",
            output: [],
            output_text: outputText,
            status: type === "response.incomplete" ? "incomplete" : "failed",
          ...(failedResponse?.usage === undefined ? {} : { usage: failedResponse.usage }),
          ...(failedResponse?.error === undefined ? {} : { error: failedResponse.error }),
          ...(failedResponse?.incomplete_details === undefined ? {} : { incomplete_details: failedResponse.incomplete_details }),
        };
        break;
      }
      }
    } catch (error) {
      if (error instanceof ResourceCleanupError || error instanceof ModelResponseError || error instanceof PersistenceError) throw error;
      if (error instanceof ResponseStreamIncompleteError) {
        const incomplete = error as ResponseStreamIncompleteError & { recoveryState?: ResponseRecoveryState };
        if (!retainEvents) delete incomplete.recoveryState;
        if (retainEvents && incomplete.recoveryState === undefined) {
          incomplete.recoveryState = {
            events,
            ...(lastEventId === undefined ? {} : { lastEventId }),
            ...(responseId === undefined ? {} : { responseId }),
          };
        }
        throw incomplete;
      }
      if (eventsSeen > 0) {
        const incomplete = new ResponseStreamIncompleteError({ cause: error });
        if (retainEvents) (incomplete as ResponseStreamIncompleteError & { recoveryState?: ResponseRecoveryState }).recoveryState = {
          events,
          ...(lastEventId === undefined ? {} : { lastEventId }),
          ...(responseId === undefined ? {} : { responseId }),
        };
        throw incomplete;
      }
      throw error;
    } finally {
      abortRequest();
      if (!exhausted) {
        try {
          // oxlint-disable-next-line no-unsafe-finally -- Cleanup failure must override a pending result; unfinished resources cannot settle successfully.
          if (typeof iterator.return !== "function") throw new Error("The stream iterator exposes no close operation");
          const closed = await iterator.return();
          // oxlint-disable-next-line no-unsafe-finally -- Cleanup failure must override a pending result; unfinished resources cannot settle successfully.
          if (closed.done !== true) throw new Error("The stream iterator did not confirm closure");
          // A timeout may leave next() active even after return() reports done.
          await pendingNext?.then(() => {}, () => {});
        } catch (cause) {
          const failure = cause instanceof ModelStreamCleanupError ? cause : new ModelStreamCleanupError(cause, response?.usage);
          this.#failure ??= failure;
          // oxlint-disable-next-line no-unsafe-finally -- Cleanup failure must override a pending result; unfinished resources cannot settle successfully.
          throw failure;
        }
      }
    }
    if (reasoningActive) this.options.onEvent?.({ type: "reasoning_finished" });
    if (!response) {
      const incomplete = new ResponseStreamIncompleteError();
      if (retainEvents) (incomplete as ResponseStreamIncompleteError & { recoveryState?: ResponseRecoveryState }).recoveryState = {
        events,
        ...(lastEventId === undefined ? {} : { lastEventId }),
        ...(responseId === undefined ? {} : { responseId }),
      };
      throw incomplete;
    }
    const result = response;
    if (result.output.length === 0 && items.size > 0) result.output = [...items.values()];
    if (!result.output_text) result.output_text = outputText;
    return result;
  }

}
