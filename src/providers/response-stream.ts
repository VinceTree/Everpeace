import type OpenAI from "openai";
import { Stream } from "openai/core/streaming";
import type { ResponseStreamLike } from "../agent/model-protocol.js";
import { ModelStreamCleanupError } from "../agent/response-errors.js";

/** Retain body ownership independently of the SDK's abort-aware SSE iterator. */
export function ownResponseStream(response: Response, controller: AbortController, signal: AbortSignal, sdk: OpenAI): ResponseStreamLike {
  if (!response.body) return Stream.fromSSEResponse<Record<string, unknown>>(response, controller, sdk);
  const reader = response.body.getReader();
  let bodySettled = false;
  let bodyErrored = false;
  let bodyError: unknown;
  void reader.closed.then(() => { bodySettled = true; }, (error: unknown) => {
    bodySettled = true;
    bodyErrored = true;
    bodyError = error;
  });
  let cancelled = false;
  let cancellation: Promise<void> | undefined;
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  const cancel = (): Promise<void> => {
    cancelled = true;
    if (cancellation) return cancellation;
    if (bodySettled) return Promise.resolve();
    cancellation = Promise.resolve().then(() => reader.cancel()).catch((error: unknown) => {
      // cancel() on an already errored body repeats its transport error.
      if (!bodyErrored || error !== bodyError) throw error;
    });
    void cancellation.catch(() => {});
    return cancellation;
  };
  const abort = () => { controller.abort(signal.reason); void cancel(); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const body = new ReadableStream<Uint8Array>({
    async pull(target) {
      pendingRead = reader.read();
      try {
        const next = await pendingRead;
        if (cancelled) return;
        if (next.done) target.close();
        else target.enqueue(next.value);
      } catch (error) {
        if (!cancelled) target.error(error);
      }
    },
    cancel,
  }, { highWaterMark: 0 });
  const ownedResponse = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  const stream = Stream.fromSSEResponse<Record<string, unknown>>(ownedResponse, controller, sdk);
  return {
    async *[Symbol.asyncIterator]() {
      let usage: unknown;
      try {
        for await (const event of stream) {
          if (["response.completed", "response.failed", "response.incomplete"].includes(String(event.type)) && event.response && typeof event.response === "object") {
            usage = (event.response as Record<string, unknown>).usage;
          }
          yield event;
        }
      } finally {
        controller.abort();
        signal.removeEventListener("abort", abort);
        const [closed] = await Promise.allSettled([cancel(), pendingRead ?? Promise.resolve()]);
        let failed = closed?.status === "rejected";
        let failure: unknown = closed?.status === "rejected" ? closed.reason : undefined;
        try { reader.releaseLock(); } catch (error) { if (!failed) failure = error; failed = true; }
        // oxlint-disable-next-line no-unsafe-finally -- Cleanup failure must override a pending result; unfinished resources cannot settle successfully.
        if (failed) throw new ModelStreamCleanupError(failure, usage);
      }
    },
  };
}
