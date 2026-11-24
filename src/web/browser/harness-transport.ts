import { eventFrames, workbenchToken } from "./connection.js";

const token = workbenchToken();
const nativeFetch = globalThis.fetch.bind(globalThis);
let desktopIconPrefix: string | undefined;

// The stock desktop controller uses HTTP for its folder actions.
globalThis.fetch = async (input, init) => {
  if (typeof input !== "string" && !(input instanceof URL)) return nativeFetch(input, init);
  const url = new URL(input, location.href);
  if (url.origin !== location.origin || url.pathname !== "/open-in-app/apps" && url.pathname !== "/open-in-app/open") {
    return nativeFetch(input, init);
  }
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token ?? ""}`);
  const response = await nativeFetch(url, { ...init, headers, redirect: "error" });
  if (response.ok && url.pathname === "/open-in-app/apps") {
    const { iconPrefix } = await response.clone().json() as { iconPrefix?: string };
    if (iconPrefix && /^\/open-in-app\/icon\/[A-Za-z0-9_-]{32}\/$/u.test(iconPrefix)) desktopIconPrefix = iconPrefix;
  }
  return response;
};

function remote(body: object, signal?: AbortSignal) {
  return fetch("/api/harness", {
    method: "POST",
    headers: { Authorization: `Bearer ${token ?? ""}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ?? null,
  });
}

class HarnessTransport {
  readonly id = crypto.randomUUID();
  readonly #streams = new Map<string, ReadableStreamDefaultController<unknown>>();
  readonly ready = this.#connect();

  async #connect(): Promise<void> {
    const response = await remote({ operation: "connect", connectionId: this.id });
    if (!response.ok || !response.body) throw new Error(`Everpeace connection failed (${response.status})`);
    void this.#read(response.body);
  }

  async #read(body: NonNullable<Response["body"]>): Promise<void> {
    try {
      for await (const frame of eventFrames(body)) {
        const { streamId, item, done } = frame as { streamId: string; item?: unknown; done?: true };
        const stream = this.#streams.get(streamId);
        if (!stream) continue;
        if (done) {
          this.#streams.delete(streamId);
          stream.close();
        } else stream.enqueue(item);
      }
    } catch {
      // The upstream connection owner retries when its event subscription fails.
    } finally {
      if (connection === this) connection = undefined;
      for (const stream of this.#streams.values()) stream.error(new Error("Everpeace connection closed"));
      this.#streams.clear();
    }
  }

  async *open(endpoint: string, payload: unknown, signal: AbortSignal): AsyncGenerator<unknown> {
    await this.ready;
    signal.throwIfAborted();
    const streamId = crypto.randomUUID();
    const stream = new ReadableStream<unknown>({
      start: controller => { this.#streams.set(streamId, controller); },
    });
    const close = () => {
      const controller = this.#streams.get(streamId);
      this.#streams.delete(streamId);
      controller?.close();
    };
    signal.addEventListener("abort", close, { once: true });
    try {
      const response = await remote({ operation: "subscribe", connectionId: this.id, streamId, endpoint, payload }, signal);
      if (!response.ok) throw new Error(`Everpeace could not open ${endpoint} (${response.status})`);
      for await (const item of stream) yield item;
    } finally {
      close();
      signal.removeEventListener("abort", close);
      void remote({ operation: "unsubscribe", connectionId: this.id, streamId }).catch(() => {});
    }
  }
}

let connection: HarnessTransport | undefined;

Object.assign(globalThis, {
  __EVERPEACE_DESKTOP_ICON__: (id: string) => desktopIconPrefix && desktopIconPrefix + encodeURIComponent(id),
  __DSH_FILE_UPLOAD__: {
    fetch(input: string | URL, init: RequestInit) {
      const url = new URL(input, location.href);
      if (url.origin !== location.origin || url.pathname !== "/api/session/uploadFileBinary") {
        throw new Error("Invalid Everpeace attachment upload route");
      }
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token ?? ""}`);
      return fetch(url, { ...init, headers, redirect: "error" });
    },
  },
  __DSH_TRANSPORT__: {
    rpc: {
      async call(_channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) {
        const response = await remote({ operation: "call", endpoint, payload, connectionId: connection?.id }, signal);
        if (!response.ok) throw new Error(`Everpeace rejected ${endpoint} (${response.status})`);
        const result = await response.json() as { ok: boolean; value?: unknown };
        if (endpoint === "workspaceFiles/readBytes" && result.ok) {
          const { base64, ...metadata } = result.value as { base64: string };
          return { ...result, value: { ...metadata, data: Uint8Array.from(atob(base64), char => char.charCodeAt(0)) } };
        }
        return result;
      },
      async *open(_channel: string, endpoint: string, payload: unknown, signal: AbortSignal) {
        const transport = connection ??= new HarnessTransport();
        try { await transport.ready; }
        catch (error) {
          if (connection === transport) connection = undefined;
          throw error;
        }
        yield* transport.open(endpoint, payload, signal);
      },
    },
  },
});
