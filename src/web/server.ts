import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MAX_INPUT_IMAGE_UPLOAD_BYTES } from "../agent/input-images.js";
import { MAX_BINARY_ATTACHMENT_BYTES } from "../agent/file-attachments.js";
import { WebRequestError, type WebWorkbench } from "./workbench.js";
import type { BrowserAssets, HarnessAsset } from "./assets.js";
import { HarnessWorkspaces } from "./harness-workspaces.js";
import type { DirectoryPicker } from "./harness-directory-picker.js";
import type { HarnessDesktop } from "./harness-desktop.js";
import { uploadPath } from "./harness-input.js";
import type { HarnessPreferences } from "./harness-preferences.js";
import { redactSecretsPreservingLayout } from "../util/redact-secrets.js";

const MAX_REQUEST_BYTES = 128 * 1024;
const HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Everpeace</title>
<link rel="stylesheet" href="/workbench.css">
<script type="module" src="/workbench.js"></script>
</head><body><div id="app"></div></body></html>`;

function respond(response: ServerResponse, code: number, value: unknown): void {
  response.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readRequestBytes(request: IncomingMessage, limit: number, error: WebRequestError): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new WebRequestError(415, "Expected JSON");
  const bytes = await readRequestBytes(request, MAX_REQUEST_BYTES, new WebRequestError(413, "Message exceeds the request size limit"));
  try {
    const data: unknown = JSON.parse(bytes.toString("utf8"));
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch { /* Invalid JSON gets the same client error as a non-object. */ }
  throw new WebRequestError(400, "Invalid request body");
}

function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string") throw new WebRequestError(400, `Expected ${key}`);
  return value;
}

function sessionField(data: Record<string, unknown>): string | null {
  return data.sessionId === null ? null : stringField(data, "sessionId");
}

function assetPath(url?: string): string {
  try { return decodeURIComponent(url?.split("?")[0] ?? ""); }
  catch { return ""; }
}

interface HarnessConnection {
  response: ServerResponse;
  signal: AbortSignal;
  subscriptions: Map<string, (() => void) | null>;
  write(data: string): void;
}

export async function startWorkbenchServer(
  workbench: WebWorkbench,
  assets: BrowserAssets,
  initialModel?: string,
  harnessAssets?: ReadonlyMap<string, HarnessAsset>,
  preferences?: HarnessPreferences,
  directoryPicker?: DirectoryPicker,
  desktop?: HarnessDesktop,
) {
  await workbench.initialize(initialModel);
  const harness = harnessAssets && new HarnessWorkspaces(workbench, preferences, directoryPicker, desktop);
  await harness?.initialize();
  const token = randomBytes(32).toString("base64url");
  const authorization = Buffer.from(`Bearer ${token}`);
  const iconPrefix = `/open-in-app/icon/${randomBytes(24).toString("base64url")}/`;
  let host = "";
  let closing: Promise<void> | undefined;
  const streams = new Set<ServerResponse>();
  const harnessConnections = new Map<string, HarnessConnection>();
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    const style = harness ? "'self' 'unsafe-inline'" : "'self'";
    const images = harness ? "'self' data: blob:" : "'self' data:";
    const connections = harness ? "'self' blob:" : "'self'";
    response.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src ${style}; connect-src ${connections}; img-src ${images}; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    void route(request, response).catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof WebRequestError ? error.status : 500;
      const message = redactSecretsPreservingLayout(error instanceof Error ? error.message : String(error));
      respond(response, status, { error: message });
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method;
    const url = request.url;
    if (request.headers.host !== host || closing) throw new WebRequestError(403, "Invalid workbench host");
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://${host}` || method === "POST" && origin !== `http://${host}`) {
      throw new WebRequestError(403, "Invalid request origin");
    }
    if (method === "GET") {
      if (harness && desktop?.available && url?.startsWith(iconPrefix)) {
        const id = url.slice(iconPrefix.length);
        const icon = /^[a-z][a-z0-9-]{0,31}$/u.test(id) ? await desktop.icon(id) : null;
        if (!icon || icon.contentType !== "image/png") throw new WebRequestError(404, "Unknown desktop icon");
        response.writeHead(200, { "Content-Type": icon.contentType });
        response.end(icon.bytes);
        return;
      }
      const harnessAsset = harnessAssets?.get(assetPath(url));
      if (harnessAsset) {
        response.writeHead(200, { "Content-Type": harnessAsset.type });
        response.end(harnessAsset.content);
        return;
      }
      if (url === "/favicon.ico") { response.writeHead(204).end(); return; }
      const asset = url === "/" ? { type: "text/html", content: HTML }
        : url === "/workbench.js" ? { type: "text/javascript", content: assets.script }
          : url === "/workbench.css" ? { type: "text/css", content: assets.styles } : undefined;
      if (asset) {
        response.writeHead(200, { "Content-Type": `${asset.type}; charset=utf-8` });
        response.end(asset.content);
        return;
      }
    }
    const provided = Buffer.from(request.headers.authorization ?? "");
    if (provided.length !== authorization.length || !timingSafeEqual(provided, authorization)) {
      throw new WebRequestError(401, "Open the workbench using the link printed by Everpeace");
    }
    if (harness && method === "GET" && url === "/open-in-app/apps") {
      const apps = await desktop?.apps() ?? [];
      respond(response, 200, { apps, iconPrefix });
      return;
    }
    if (harness && method === "POST" && url === "/open-in-app/open") {
      const lifetime = new AbortController();
      const cancel = () => lifetime.abort();
      response.once("close", cancel);
      try {
        const data = await readBody(request);
        const result = await harness.openDirectory(stringField(data, "app"), stringField(data, "path"), lifetime.signal);
        if (!lifetime.signal.aborted) respond(response, 200, result);
      } catch (error) {
        if (!lifetime.signal.aborted) throw error;
      } finally { response.off("close", cancel); }
      return;
    }
    if (method === "GET" && url === "/api/events") {
      if (streams.size >= 16) throw new WebRequestError(429, "Too many open workbench tabs");
      streams.add(response);
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.flushHeaders();
      const write = (data: string) => {
        // Reconnect with a fresh snapshot if a browser stops reading.
        if (response.writableLength > 1024 * 1024) response.destroy();
        else response.write(data);
      };
      let selected: string | null = null;
      const unsubscribe = workbench.subscribe(event => {
        if ("state" in event) {
          selected = event.state.sessionId;
          write(`data: ${JSON.stringify(event)}\n\n`);
        } else if (event.activity.sessionId === selected && event.activity.turn) {
          write(`data: ${JSON.stringify({ turn: event.activity.turn })}\n\n`);
        }
      });
      const heartbeat = setInterval(() => write(": heartbeat\n\n"), 15_000);
      response.once("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
        streams.delete(response);
      });
      return;
    }
    if (method !== "POST") throw new WebRequestError(404, "Unknown workbench route");
    if (harness && url?.split("?", 1)[0] === uploadPath) {
      if (request.headers["content-type"]?.split(";", 1)[0] !== "application/octet-stream") {
        throw new WebRequestError(415, "Expected raw attachment bytes");
      }
      const params = new URL(url, `http://${host}`).searchParams;
      const image = params.has("mediaType");
      const lifetime = new AbortController();
      const cancel = () => lifetime.abort();
      response.once("close", cancel);
      try {
        const limit = image ? MAX_INPUT_IMAGE_UPLOAD_BYTES : MAX_BINARY_ATTACHMENT_BYTES;
        const message = image ? "Image attachment exceeds 4 MiB" : "Attachment exceeds 8 MiB";
        const bytes = await readRequestBytes(request, limit, new WebRequestError(413, message, "session/attachment-invalid"));
        if (lifetime.signal.aborted) return;
        const value = await harness.uploadFile(params, bytes, lifetime.signal);
        if (!lifetime.signal.aborted) respond(response, 200, { ok: true, value });
      } catch (error) {
        if (lifetime.signal.aborted) return;
        if (!(error instanceof WebRequestError)) throw error;
        respond(response, 200, { ok: false, error: { code: error.code, message: error.message, details: error.details } });
      } finally { response.off("close", cancel); }
      return;
    }
    const data = await readBody(request);
    switch (url) {
      case "/api/harness": {
        if (!harness) throw new WebRequestError(404, "DeepSeek Harness client is unavailable");
        const operation = stringField(data, "operation");
        if (operation === "connect") {
          const id = stringField(data, "connectionId");
          if (id.length > 64 || harnessConnections.has(id)) throw new WebRequestError(409, "Invalid workbench connection");
          if (streams.size >= 16) throw new WebRequestError(429, "Too many open workbench connections");
          const subscriptions = new Map<string, (() => void) | null>();
          const lifetime = new AbortController();
          streams.add(response);
          const write = (chunk: string) => {
            if (response.writableEnded || response.destroyed) return;
            if (response.writableLength > 8 * 1024 * 1024) response.destroy();
            else response.write(chunk);
          };
          harnessConnections.set(id, { response, signal: lifetime.signal, subscriptions, write });
          const heartbeat = setInterval(() => write(": heartbeat\n\n"), 15_000);
          response.once("close", () => {
            lifetime.abort();
            streams.delete(response);
            harnessConnections.delete(id);
            for (const unsubscribe of subscriptions.values()) unsubscribe?.();
            subscriptions.clear();
            clearInterval(heartbeat);
          });
          response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
          response.flushHeaders();
          return;
        }
        if (operation === "subscribe" || operation === "unsubscribe") {
          const id = stringField(data, "connectionId");
          const streamId = stringField(data, "streamId");
          const connection = harnessConnections.get(id);
          if (!connection || connection.response.destroyed) throw new WebRequestError(410, "Workbench connection closed");
          const { subscriptions, write } = connection;
          if (operation === "unsubscribe") {
            subscriptions.get(streamId)?.();
            subscriptions.delete(streamId);
          } else {
            if (streamId.length > 64 || subscriptions.has(streamId)) throw new WebRequestError(409, "Invalid workbench stream");
            if (subscriptions.size >= 64) throw new WebRequestError(429, "Too many workbench subscriptions");
            subscriptions.set(streamId, null);
            try {
              const unsubscribe = await harness.subscribe(stringField(data, "endpoint"), data.payload, item => {
                if (subscriptions.has(streamId)) write(`data: ${JSON.stringify({ streamId, item })}\n\n`);
              }, connection.signal, () => {
                if (!subscriptions.has(streamId)) return;
                const dispose = subscriptions.get(streamId);
                subscriptions.delete(streamId);
                write(`data: ${JSON.stringify({ streamId, done: true })}\n\n`);
                dispose?.();
              });
              if (subscriptions.has(streamId)) subscriptions.set(streamId, unsubscribe);
              else unsubscribe();
            } catch (error) {
              subscriptions.delete(streamId);
              throw error;
            }
          }
          respond(response, 200, { ok: true });
          return;
        }
        if (operation !== "call") throw new WebRequestError(400, "Invalid Harness operation");
        const lifetime = new AbortController();
        const cancel = () => lifetime.abort();
        response.once("close", cancel);
        try {
          const connection = typeof data.connectionId === "string" ? harnessConnections.get(data.connectionId) : undefined;
          const value = await harness.call(stringField(data, "endpoint"), data.payload, lifetime.signal, connection?.signal);
          if (!lifetime.signal.aborted) respond(response, 200, { ok: true, value });
        } catch (error) {
          if (lifetime.signal.aborted) return;
          if (!(error instanceof WebRequestError)) throw error;
          respond(response, 200, {
            ok: false, error: { code: error.code, message: redactSecretsPreservingLayout(error.message), details: error.details },
          });
        } finally { response.off("close", cancel); }
        return;
      }
      case "/api/session": await workbench.selectSession(sessionField(data)); break;
      case "/api/model": await workbench.selectModel(stringField(data, "modelId"), sessionField(data)); break;
      case "/api/send": workbench.start(stringField(data, "prompt"), sessionField(data), stringField(data, "modelId")); break;
      case "/api/stop": workbench.stop(stringField(data, "turnId")); break;
      case "/api/answer": workbench.answer(stringField(data, "turnId"), stringField(data, "requestId"), data.answer); break;
      default: throw new WebRequestError(404, "Unknown workbench route");
    }
    respond(response, 200, { ok: true });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine the workbench address");
  host = `127.0.0.1:${address.port}`;
  const close = () => closing ??= (async () => {
    for (const stream of streams) stream.end();
    const stopped = new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    await Promise.all([stopped, harness ? harness.close() : workbench.close()]);
  })();
  return { url: `http://${host}/#${token}`, close };
}
