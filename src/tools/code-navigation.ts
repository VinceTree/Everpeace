import { promises as fs } from "node:fs";
import { connect, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startCodexDuplexProcess, type CodexDuplexExit, type CodexDuplexProcess } from "../codex/cli.js";
import { decodeTextFile } from "./file-version.js";
import { createLspSandboxPolicy, modelShellEnvironment, nativeLspPermissionProfileArgs, type LspSandboxPolicy } from "./sandbox-policy.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_LOCATIONS = 100;
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_HOVER_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_INCOMING_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export const CODE_NAVIGATION_TOOL_DEFINITION = {
  type: "function" as const,
  name: "code_navigation",
  description: "Use the configured sandboxed read-only TypeScript language server for definition, references, implementation, or hover. Positions are one-based UTF-16 line and column values.",
  parameters: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["definition", "references", "implementation", "hover"] },
      path: { type: "string", description: "Workspace-relative source file path." },
      line: { type: "integer", minimum: 1 },
      column: { type: "integer", minimum: 1, description: "One-based UTF-16 column." },
    },
    required: ["operation", "path", "line", "column"],
    additionalProperties: false,
  },
  strict: true,
};

export type CodeNavigationOperation = "definition" | "references" | "implementation" | "hover";

export interface CodeNavigationRequest {
  operation: CodeNavigationOperation;
  path: string;
  line: number;
  column: number;
}

export interface CodeNavigationLocation {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface CodeNavigationResult {
  operation: CodeNavigationOperation;
  locations?: CodeNavigationLocation[];
  hover?: string | null;
  truncated?: boolean;
}

export interface CodeNavigationRuntimeLike {
  query(request: CodeNavigationRequest, signal?: AbortSignal): Promise<CodeNavigationResult>;
  describe(): string;
  probeIsolation?(signal?: AbortSignal): Promise<void>;
  getIsolationEvidence?(): Readonly<LanguageServerIsolationEvidence> | undefined;
}

export interface LanguageServerIsolationEvidence {
  outcome: "allowed" | "denied" | "inconclusive";
  positiveControl: "passed" | "failed" | "not_run";
  transport: "tcp_ipv4";
  target: "non_loopback" | "loopback";
  reason: string;
  socketError?: string;
}

export class LanguageServerIsolationError extends Error {
  constructor(readonly evidence: Readonly<LanguageServerIsolationEvidence>) {
    super(`Language-server isolation is unavailable: ${evidence.outcome} (${evidence.reason}); ${evidence.outcome === "allowed" ? "direct networking was permitted" : "direct networking was not conclusively denied"}; use lexical search`);
    this.name = "LanguageServerIsolationError";
  }
}

export interface LanguageServerProcess {
  readonly stdout: Readable;
  readonly exit: Promise<CodexDuplexExit | void>;
  write(data: Uint8Array | string): Promise<void>;
  closeInput(): void;
  terminate(): Promise<unknown>;
}

export type LanguageServerProcessFactory = (options: {
  command: string;
  args: readonly string[];
  cwd: string;
  policy: LspSandboxPolicy;
}) => LanguageServerProcess;

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function parseArguments(value: string): CodeNavigationRequest {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Invalid code_navigation arguments"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid code_navigation arguments");
  const record = parsed as Record<string, unknown>;
  if (!(["definition", "references", "implementation", "hover"] as const).includes(record.operation as CodeNavigationOperation)
    || typeof record.path !== "string" || !record.path || record.path.includes("\0")
    || !Number.isSafeInteger(record.line) || (record.line as number) < 1
    || !Number.isSafeInteger(record.column) || (record.column as number) < 1) {
    throw new Error("Invalid code_navigation arguments");
  }
  return record as unknown as CodeNavigationRequest;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.value === "string") return record.value;
  if (record.contents !== undefined) return contentText(record.contents);
  return "";
}

function nativeProcessFactory(options: Parameters<LanguageServerProcessFactory>[0]): CodexDuplexProcess {
  return startCodexDuplexProcess([
    "sandbox",
    ...nativeLspPermissionProfileArgs(options.policy),
    "-C",
    options.cwd,
    ...options.policy.readableRoots.flatMap((root) => ["--sandbox-state-readable-root", root]),
    "--sandbox-state-disable-network",
    "--include-managed-config",
    "-c",
    "shell_environment_policy.ignore_default_excludes=false",
    "--",
    options.command,
    ...options.args,
  ], { cwd: options.cwd, env: modelShellEnvironment(process.env), stderrMaxBytes: MAX_STDERR_BYTES });
}

class JsonRpcProcess {
  readonly #process: LanguageServerProcess;
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  #nextId = 1;
  #buffer = Buffer.alloc(0);
  #incomingBytes = 0;
  #closed: Error | undefined;
  #writes: Promise<void> = Promise.resolve();

  constructor(process: LanguageServerProcess) {
    this.#process = process;
    process.stdout.on("data", (chunk: Buffer | string) => {
      if (this.#closed) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.#incomingBytes += bytes.length;
      if (this.#incomingBytes > MAX_INCOMING_BYTES) { this.#fail(new Error("Language server exceeded the 8 MiB incoming-traffic limit")); return; }
      this.#buffer = Buffer.concat([this.#buffer, bytes]);
      this.#drain();
    });
    process.stdout.once("error", (error) => this.#fail(error));
    void process.exit.then(
      (result) => {
        const details = result && typeof result === "object"
          ? ` with ${result.exitCode === null ? (result.signal ?? "no exit code") : `exit code ${result.exitCode}`}${result.stderr ? `: ${result.stderr}` : ""}`
          : "";
        this.#fail(new Error(`Language server exited${details}`));
      },
      (error: unknown) => this.#fail(error instanceof Error ? error : new Error(String(error))),
    );
  }

  get closed(): boolean {
    return this.#closed !== undefined;
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (this.#closed) throw this.#closed;
    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    const aborted = () => {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      pending.reject(signal.reason instanceof Error ? signal.reason : new Error("Language server request cancelled"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    try {
      const [, value] = await Promise.all([
        this.#write({ jsonrpc: "2.0", id, method, params }),
        result,
      ]);
      return value;
    } finally {
      this.#pending.delete(id);
      signal.removeEventListener("abort", aborted);
    }
  }

  async close(): Promise<void> {
    this.#process.closeInput();
    await this.#process.terminate();
  }

  #write(message: Record<string, unknown>): Promise<void> {
    if (this.#closed) return Promise.reject(this.#closed);
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
    const write = this.#writes.then(() => this.#process.write(frame));
    this.#writes = write.catch(() => undefined);
    return write;
  }

  #drain(): void {
    while (!this.#closed) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (this.#buffer.length > MAX_HEADER_BYTES) this.#fail(new Error("Language server JSON-RPC header exceeds 8 KiB"));
        return;
      }
      if (headerEnd > MAX_HEADER_BYTES) { this.#fail(new Error("Language server JSON-RPC header exceeds 8 KiB")); return; }
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const length = /(?:^|\r\n)Content-Length:\s*(\d+)/iu.exec(header)?.[1];
      if (!length) { this.#fail(new Error("Language server sent an invalid JSON-RPC frame")); return; }
      const bodyLength = Number(length);
      if (!Number.isSafeInteger(bodyLength) || bodyLength < 0 || bodyLength > MAX_FRAME_BYTES) {
        this.#fail(new Error("Language server JSON-RPC frame exceeds 2 MiB or has an invalid length"));
        return;
      }
      const bodyStart = headerEnd + 4;
      if (this.#buffer.length < bodyStart + bodyLength) return;
      const body = this.#buffer.subarray(bodyStart, bodyStart + bodyLength).toString("utf8");
      this.#buffer = this.#buffer.subarray(bodyStart + bodyLength);
      let message: Record<string, unknown>;
      try { message = JSON.parse(body) as Record<string, unknown>; }
      catch { this.#fail(new Error("Language server sent invalid JSON")); return; }
      if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method === "string") {
        void this.#write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Server requests are disabled" } })
          .catch((error: unknown) => this.#fail(error instanceof Error ? error : new Error(String(error))));
      } else if (typeof message.id === "number") {
        const pending = this.#pending.get(message.id);
        if (!pending) continue;
        this.#pending.delete(message.id);
        if (message.error && typeof message.error === "object") pending.reject(new Error(contentText((message.error as Record<string, unknown>).message) || "Language server request failed"));
        else pending.resolve(message.result);
      }
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function languageId(filename: string): string {
  if (/\.tsx$/iu.test(filename)) return "typescriptreact";
  if (/\.ts$/iu.test(filename)) return "typescript";
  if (/\.jsx$/iu.test(filename)) return "javascriptreact";
  return "javascript";
}

function operationMethod(operation: CodeNavigationOperation): string {
  return operation === "definition" ? "textDocument/definition"
    : operation === "references" ? "textDocument/references"
      : operation === "implementation" ? "textDocument/implementation"
        : "textDocument/hover";
}

function supportsOperation(initializeResult: unknown, operation: CodeNavigationOperation): boolean {
  if (!initializeResult || typeof initializeResult !== "object") return false;
  const capabilities = (initializeResult as Record<string, unknown>).capabilities;
  if (!capabilities || typeof capabilities !== "object") return false;
  const key = operation === "definition" ? "definitionProvider"
    : operation === "references" ? "referencesProvider"
      : operation === "implementation" ? "implementationProvider"
        : "hoverProvider";
  const value = (capabilities as Record<string, unknown>)[key];
  return value === true || (typeof value === "object" && value !== null);
}

function validateSynchronization(initializeResult: unknown): void {
  const capabilities = (initializeResult as { capabilities: Record<string, unknown> }).capabilities;
  if (capabilities.positionEncoding !== undefined && capabilities.positionEncoding !== "utf-16") {
    throw new Error("Language server must use UTF-16 position encoding");
  }
  const sync = capabilities.textDocumentSync;
  if (sync !== 1 && sync !== 2 && !(sync && typeof sync === "object" && (sync as Record<string, unknown>).openClose === true)) {
    throw new Error("Language server does not support transient document open/close synchronization");
  }
}

function boundedUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

async function positiveNetworkControl(host: string, port: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port });
    let settled = false;
    let received = "";
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const aborted = () => finish(signal?.reason ?? new Error("Isolation probe cancelled"));
    const timer = setTimeout(() => finish(new Error("Host network positive control timed out")), 1_500);
    socket.on("data", (data: Buffer) => {
      received += data.toString("utf8");
      if (received === "everpeace-lsp-probe") finish();
      else if (!"everpeace-lsp-probe".startsWith(received)) finish(new Error("Invalid positive-control response"));
    });
    socket.once("end", () => finish(new Error("Positive-control connection closed before confirmation")));
    socket.once("error", finish);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

function validatePosition(text: string, request: CodeNavigationRequest): void {
  const line = text.replace(/\r\n/gu, "\n").split("\n")[request.line - 1];
  if (line === undefined || request.column - 1 > line.length) throw new Error("Code navigation position is outside the current UTF-16 document bounds");
}

export class CodeNavigationRuntime implements CodeNavigationRuntimeLike {
  readonly #workspacePath: string;
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #policy: LspSandboxPolicy;
  readonly #startProcess: LanguageServerProcessFactory;
  readonly #permissionRevision: (() => string) | undefined;
  readonly #verifyIsolation: boolean;
  #isolationProbe: Promise<void> | undefined;
  #isolationEvidence: Readonly<LanguageServerIsolationEvidence> | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: {
    workspacePath: string;
    command: string;
    args?: readonly string[];
    policy: LspSandboxPolicy;
    startProcess?: LanguageServerProcessFactory;
    permissionRevision?: () => string;
    verifyIsolation?: boolean;
  }) {
    this.#workspacePath = path.resolve(options.workspacePath);
    this.#command = options.command;
    this.#args = [...(options.args ?? ["--stdio"])];
    this.#policy = options.policy;
    this.#startProcess = options.startProcess ?? nativeProcessFactory;
    this.#permissionRevision = options.permissionRevision;
    this.#verifyIsolation = options.verifyIsolation ?? options.startProcess === undefined;
  }

  describe(): string {
    return `${this.#command} ${this.#args.join(" ")} (native read-only sandbox)`.trim();
  }

  getIsolationEvidence(): Readonly<LanguageServerIsolationEvidence> | undefined {
    return this.#isolationEvidence;
  }

  probeIsolation(signal?: AbortSignal): Promise<void> {
    if (!this.#isolationProbe) {
      const attempt = this.#probeNetworkIsolation(signal);
      this.#isolationProbe = attempt.catch((error: unknown) => {
        if (signal?.aborted) this.#isolationProbe = undefined;
        throw error;
      });
    }
    return this.#isolationProbe;
  }

  query(request: CodeNavigationRequest, signal?: AbortSignal): Promise<CodeNavigationResult> {
    const run = this.#tail.then(() => this.#query(request, signal));
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #query(request: CodeNavigationRequest, signal?: AbortSignal): Promise<CodeNavigationResult> {
    const timeout = new AbortController();
    const policyChange = new AbortController();
    const expectedRevision = this.#permissionRevision?.();
    const timer = setTimeout(() => timeout.abort(new Error(`Language server request exceeded ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    const policyTimer = expectedRevision === undefined ? undefined : setInterval(() => {
      if (this.#permissionRevision?.() !== expectedRevision) policyChange.abort(new Error("Permission policy changed during language-server execution"));
    }, 100);
    policyTimer?.unref?.();
    const combined = AbortSignal.any([...(signal ? [signal] : []), timeout.signal, policyChange.signal]);
    let rpc: JsonRpcProcess | undefined;
    let openedUri: string | undefined;
    try {
      combined.throwIfAborted();
      if (this.#verifyIsolation) await this.probeIsolation(combined);
      const root = await fs.realpath(this.#workspacePath);
      const deniedRoots = [...this.#policy.deniedRoots, ...await Promise.all(this.#policy.deniedRoots.map((denied) => fs.realpath(denied).catch(() => denied)))];
      const denied = (target: string) => deniedRoots.some((deniedRoot) => inside(deniedRoot, target));
      const requestedPath = path.resolve(root, request.path);
      if (denied(requestedPath)) throw new Error("Code navigation cannot read protected application state or control metadata");
      const target = await fs.realpath(requestedPath);
      if (!inside(root, target)) throw new Error("Code navigation is limited to the current workspace");
      if (denied(target)) throw new Error("Code navigation cannot read protected application state or control metadata");
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) throw new Error("Code navigation requires a bounded regular file");
      const text = decodeTextFile(await fs.readFile(target)).text;
      validatePosition(text, request);
      const uri = pathToFileURL(target).href;
      rpc = new JsonRpcProcess(this.#startProcess({ command: this.#command, args: this.#args, cwd: root, policy: this.#policy }));
      const initialized = await rpc.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(root).href,
        capabilities: { general: { positionEncodings: ["utf-16"] }, workspace: { applyEdit: false }, textDocument: { definition: {}, references: {}, implementation: {}, hover: {} } },
      }, combined);
      if (!supportsOperation(initialized, request.operation)) throw new Error(`Language server does not advertise ${request.operation} support`);
      validateSynchronization(initialized);
      await rpc.notify("initialized", {});
      await rpc.notify("textDocument/didOpen", { textDocument: { uri, languageId: languageId(target), version: 1, text } });
      openedUri = uri;
      const raw = await rpc.request(operationMethod(request.operation), {
        textDocument: { uri },
        position: { line: request.line - 1, character: request.column - 1 },
        ...(request.operation === "references" ? { context: { includeDeclaration: true } } : {}),
      }, combined);
      if (request.operation === "hover") {
        const hover = contentText(raw);
        return { operation: request.operation, hover: hover ? boundedUtf8(hover, MAX_HOVER_BYTES) : null, truncated: Buffer.byteLength(hover, "utf8") > MAX_HOVER_BYTES };
      }
      const values = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      const locations: CodeNavigationLocation[] = [];
      for (const value of values.slice(0, MAX_LOCATIONS)) {
        if (!value || typeof value !== "object") continue;
        const record = value as Record<string, unknown>;
        const locationUri = typeof record.uri === "string" ? record.uri : typeof record.targetUri === "string" ? record.targetUri : undefined;
        const range = (record.range ?? record.targetSelectionRange) as { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } } | undefined;
        if (!locationUri || locationUri.slice(0, 5).toLowerCase() !== "file:" || !range?.start || !range.end) continue;
        let locationPath: string;
        try {
          const requestedLocation = fileURLToPath(locationUri);
          if (denied(requestedLocation)) continue;
          locationPath = await fs.realpath(requestedLocation);
        }
        catch { continue; }
        if (!inside(root, locationPath) || denied(locationPath)) continue;
        if (![range.start.line, range.start.character, range.end.line, range.end.character].every((coordinate) => Number.isSafeInteger(coordinate) && (coordinate as number) >= 0)) continue;
        locations.push({
          path: path.relative(root, locationPath).split(path.sep).join("/"),
          line: (range.start.line as number) + 1,
          column: (range.start.character as number) + 1,
          endLine: (range.end.line as number) + 1,
          endColumn: (range.end.character as number) + 1,
        });
      }
      return { operation: request.operation, locations, truncated: values.length > MAX_LOCATIONS };
    } finally {
      clearTimeout(timer);
      if (policyTimer) clearInterval(policyTimer);
      try {
        if (rpc && openedUri && !combined.aborted && !rpc.closed) await rpc.notify("textDocument/didClose", { textDocument: { uri: openedUri } });
      } finally {
        await rpc?.close();
      }
    }
  }

  async #probeNetworkIsolation(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    let evidence: LanguageServerIsolationEvidence = {
      outcome: "inconclusive", positiveControl: "not_run", transport: "tcp_ipv4", target: "loopback", reason: "probe_not_completed",
    };
    const listener = createServer();
    const sockets = new Set<import("node:net").Socket>();
    let acceptedConnections = 0;
    listener.on("connection", (socket) => {
      acceptedConnections += 1;
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
      socket.once("close", () => sockets.delete(socket));
      socket.end("everpeace-lsp-probe");
    });
    let processHandle: LanguageServerProcess | undefined;
    try {
      const root = await fs.realpath(this.#workspacePath);
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "0.0.0.0", resolve);
      });
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("No network listener address");
      const host = Object.values(os.networkInterfaces()).flat().find((candidate) =>
        candidate?.family === "IPv4" && !candidate.internal)?.address ?? "127.0.0.1";
      evidence.target = host === "127.0.0.1" ? "loopback" : "non_loopback";
      try {
        await positiveNetworkControl(host, address.port, signal);
        evidence.positiveControl = "passed";
      } catch (error) {
        evidence.positiveControl = "failed";
        evidence.reason = "positive_control_failed";
        throw error;
      }
      signal?.throwIfAborted();
      const baselineConnections = acceptedConnections;
      const script = [
        "const { connect } = require('node:net');",
        "let done = false; let timer;",
        "const finish = (value) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); process.stdout.write(JSON.stringify(value)); };",
        "const socket = connect({ host: process.argv[1], port: Number(process.argv[2]) });",
        "socket.once('connect', () => finish({ outcome: 'allowed' }));",
        "socket.once('error', (error) => finish({ outcome: ['EACCES', 'EPERM'].includes(error.code) ? 'denied' : 'inconclusive', code: error.code }));",
        "timer = setTimeout(() => finish({ outcome: 'inconclusive', code: 'TIMEOUT' }), 1500);",
      ].join("");
      processHandle = this.#startProcess({
        command: process.execPath,
        args: ["-e", script, host, String(address.port)],
        cwd: root,
        policy: this.#policy,
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      processHandle.stdout.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (bytes < 4096) chunks.push(value.subarray(0, 4096 - bytes));
        bytes += value.length;
      });
      processHandle.closeInput();
      const timeout = AbortSignal.timeout(5_000);
      const combined = AbortSignal.any([...(signal ? [signal] : []), timeout]);
      combined.throwIfAborted();
      let rejectAborted!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAborted = () => reject(combined.reason);
        combined.addEventListener("abort", rejectAborted, { once: true });
      });
      const result = await Promise.race([processHandle.exit, aborted]).finally(() => combined.removeEventListener("abort", rejectAborted));
      const output = Buffer.concat(chunks).toString("utf8").trim();
      if (result && result.exitCode !== 0) {
        evidence.reason = "probe_process_failed";
        throw new Error("Isolation probe process failed");
      }
      let parsed: unknown;
      try { parsed = JSON.parse(output); } catch { /* classified as inconclusive below */ }
      const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
      const errorCode = typeof record?.code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/u.test(record.code) ? record.code : undefined;
      if (acceptedConnections > baselineConnections || (bytes <= 4096 && record?.outcome === "allowed")) {
        evidence = { ...evidence, outcome: "allowed", reason: "connection_succeeded" };
      } else if (bytes <= 4096 && record?.outcome === "denied" && (errorCode === "EACCES" || errorCode === "EPERM")) {
        evidence = { ...evidence, outcome: "denied", reason: "socket_permission_denied", socketError: errorCode };
      } else {
        evidence = { ...evidence, reason: errorCode === "TIMEOUT" ? "socket_timeout" : record?.outcome === "inconclusive" ? "socket_error_not_denial" : "invalid_probe_output", ...(errorCode ? { socketError: errorCode } : {}) };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (evidence.reason === "probe_not_completed") evidence.reason = "probe_failed";
    } finally {
      try {
        try { await processHandle?.terminate(); }
        catch {
          evidence = { ...evidence, outcome: "inconclusive", reason: "probe_cleanup_failed" };
        }
      } finally {
        for (const socket of sockets) socket.destroy();
        if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
        this.#isolationEvidence = Object.freeze(evidence);
      }
    }
    if (evidence.outcome !== "denied") throw new LanguageServerIsolationError(this.#isolationEvidence!);
  }
}

export function parseCodeNavigationArguments(value: string): CodeNavigationRequest {
  return parseArguments(value);
}

function jsonStringArray(value: string | undefined, name: string): string[] | undefined {
  if (!value) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error(`${name} must be a JSON array of strings`);
  return parsed;
}

export function createCodeNavigationFromEnvironment(
  workspacePath: string,
  options: { permissionRevision?: () => string; startProcess?: LanguageServerProcessFactory } = {},
): CodeNavigationRuntime | undefined {
  const command = process.env.EVERPEACE_TYPESCRIPT_LSP?.trim();
  if (!command) return undefined;
  const args = jsonStringArray(process.env.EVERPEACE_TYPESCRIPT_LSP_ARGS, "EVERPEACE_TYPESCRIPT_LSP_ARGS");
  const configuredRoots = jsonStringArray(process.env.EVERPEACE_TYPESCRIPT_LSP_READ_ROOTS, "EVERPEACE_TYPESCRIPT_LSP_READ_ROOTS") ?? [];
  const commandRoots = path.isAbsolute(command) ? [path.dirname(command)] : [];
  const policy = createLspSandboxPolicy(workspacePath, [...commandRoots, ...configuredRoots]);
  return new CodeNavigationRuntime({
    workspacePath,
    command,
    policy,
    ...(args === undefined ? {} : { args }),
    ...(options.permissionRevision ? { permissionRevision: options.permissionRevision } : {}),
    ...(options.startProcess ? { startProcess: options.startProcess } : {}),
  });
}

export const codeNavigationLimits = {
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  maxLocations: MAX_LOCATIONS,
  maxDocumentBytes: MAX_DOCUMENT_BYTES,
  maxHeaderBytes: MAX_HEADER_BYTES,
  maxFrameBytes: MAX_FRAME_BYTES,
  maxIncomingBytes: MAX_INCOMING_BYTES,
  maxStderrBytes: MAX_STDERR_BYTES,
} as const;
