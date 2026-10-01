import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stopProcessTree } from "./process-cancel.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_LOCATIONS = 100;
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_HOVER_BYTES = 64 * 1024;

export const CODE_NAVIGATION_TOOL_DEFINITION = {
  type: "function" as const,
  name: "code_navigation",
  description: "Use the configured read-only TypeScript language server for definition, references, implementation, or hover. Positions are one-based UTF-16 line and column values.",
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
}

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

class JsonRpcProcess {
  readonly #child: ReturnType<typeof spawn>;
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  #nextId = 1;
  #buffer = Buffer.alloc(0);
  #closed: Error | undefined;

  constructor(command: string, args: readonly string[], cwd: string) {
    this.#child = spawn(command, [...args], {
      cwd,
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout!.on("data", (chunk: Buffer) => { this.#buffer = Buffer.concat([this.#buffer, chunk]); this.#drain(); });
    this.#child.once("error", (error) => this.#fail(error));
    this.#child.once("close", (code) => this.#fail(new Error(`Language server exited with ${code ?? "no exit code"}`)));
  }

  notify(method: string, params?: unknown): void {
    this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
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
    this.#write({ jsonrpc: "2.0", id, method, params });
    try { return await result; }
    finally { signal.removeEventListener("abort", aborted); }
  }

  async close(): Promise<void> {
    if (this.#child.exitCode !== null || this.#child.killed) return;
    const closed = new Promise<void>((resolve) => this.#child.once("close", () => resolve()));
    if (this.#child.pid) stopProcessTree(this.#child.pid);
    else this.#child.kill();
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  }

  #write(message: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.#child.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.#child.stdin!.write(body);
  }

  #drain(): void {
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const length = /(?:^|\r\n)Content-Length:\s*(\d+)/iu.exec(header)?.[1];
      if (!length) { this.#fail(new Error("Language server sent an invalid JSON-RPC frame")); return; }
      const bodyLength = Number(length);
      const bodyStart = headerEnd + 4;
      if (this.#buffer.length < bodyStart + bodyLength) return;
      const body = this.#buffer.subarray(bodyStart, bodyStart + bodyLength).toString("utf8");
      this.#buffer = this.#buffer.subarray(bodyStart + bodyLength);
      let message: Record<string, unknown>;
      try { message = JSON.parse(body) as Record<string, unknown>; }
      catch { this.#fail(new Error("Language server sent invalid JSON")); return; }
      if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method === "string") {
        // The coding CLI is read-only from the server's perspective. Reject all server requests,
        // including workspace/applyEdit and workspace/executeCommand.
        this.#write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Server requests are disabled" } });
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

export class CodeNavigationRuntime implements CodeNavigationRuntimeLike {
  readonly #workspacePath: string;
  readonly #command: string;
  readonly #args: readonly string[];
  #tail: Promise<void> = Promise.resolve();

  constructor(options: { workspacePath: string; command: string; args?: readonly string[] }) {
    this.#workspacePath = path.resolve(options.workspacePath);
    this.#command = options.command;
    this.#args = [...(options.args ?? ["--stdio"])];
  }

  describe(): string {
    return `${this.#command} ${this.#args.join(" ")}`.trim();
  }

  query(request: CodeNavigationRequest, signal?: AbortSignal): Promise<CodeNavigationResult> {
    const run = this.#tail.then(() => this.#query(request, signal));
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #query(request: CodeNavigationRequest, signal?: AbortSignal): Promise<CodeNavigationResult> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error(`Language server request exceeded ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    let rpc: JsonRpcProcess | undefined;
    try {
      combined.throwIfAborted();
      const root = await fs.realpath(this.#workspacePath);
      const target = await fs.realpath(path.resolve(root, request.path));
      if (!inside(root, target)) throw new Error("Code navigation is limited to the current workspace");
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) throw new Error("Code navigation requires a bounded regular file");
      const text = await fs.readFile(target, "utf8");
      const uri = pathToFileURL(target).href;
      rpc = new JsonRpcProcess(this.#command, this.#args, root);
      await rpc.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(root).href,
        capabilities: { workspace: { applyEdit: false }, textDocument: { definition: {}, references: {}, implementation: {}, hover: {} } },
      }, combined);
      rpc.notify("initialized", {});
      rpc.notify("textDocument/didOpen", { textDocument: { uri, languageId: languageId(target), version: 1, text } });
      const position = { line: request.line - 1, character: request.column - 1 };
      const method = request.operation === "definition" ? "textDocument/definition"
        : request.operation === "references" ? "textDocument/references"
          : request.operation === "implementation" ? "textDocument/implementation"
            : "textDocument/hover";
      const raw = await rpc.request(method, {
        textDocument: { uri },
        position,
        ...(request.operation === "references" ? { context: { includeDeclaration: true } } : {}),
      }, combined);
      rpc.notify("textDocument/didClose", { textDocument: { uri } });
      if (request.operation === "hover") {
        const hover = contentText(raw);
        return { operation: request.operation, hover: hover ? Buffer.from(hover, "utf8").subarray(0, MAX_HOVER_BYTES).toString("utf8") : null, truncated: Buffer.byteLength(hover, "utf8") > MAX_HOVER_BYTES };
      }
      const values = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      const locations: CodeNavigationLocation[] = [];
      for (const value of values.slice(0, MAX_LOCATIONS)) {
        if (!value || typeof value !== "object") continue;
        const record = value as Record<string, unknown>;
        const locationUri = typeof record.uri === "string" ? record.uri : typeof record.targetUri === "string" ? record.targetUri : undefined;
        const range = (record.range ?? record.targetSelectionRange) as { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } } | undefined;
        if (!locationUri || locationUri.slice(0, 5).toLowerCase() !== "file:" || !range?.start || !range.end) continue;
        const locationPath = fileURLToPath(locationUri);
        if (!inside(root, locationPath)) continue;
        if (![range.start.line, range.start.character, range.end.line, range.end.character].every(Number.isSafeInteger)) continue;
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
      await rpc?.close();
    }
  }
}

export function parseCodeNavigationArguments(value: string): CodeNavigationRequest {
  return parseArguments(value);
}

export function createCodeNavigationFromEnvironment(workspacePath: string): CodeNavigationRuntime | undefined {
  const command = process.env.EVERPEACE_TYPESCRIPT_LSP?.trim();
  if (!command) return undefined;
  let args: string[] | undefined;
  const encoded = process.env.EVERPEACE_TYPESCRIPT_LSP_ARGS;
  if (encoded) {
    const parsed: unknown = JSON.parse(encoded);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("EVERPEACE_TYPESCRIPT_LSP_ARGS must be a JSON array of strings");
    args = parsed;
  }
  return new CodeNavigationRuntime({ workspacePath, command, ...(args === undefined ? {} : { args }) });
}

export const codeNavigationLimits = { requestTimeoutMs: REQUEST_TIMEOUT_MS, maxLocations: MAX_LOCATIONS, maxDocumentBytes: MAX_DOCUMENT_BYTES } as const;
