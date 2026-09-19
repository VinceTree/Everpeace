import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readCodexCliJson } from "../codex/cli.js";
import { retainOutput } from "../tools/command-record.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const MAX_MCP_RESULT_BYTES = 1024 * 1024;

interface RawStdioTransport {
  type: "stdio";
  command: string;
  args?: string[] | null;
  env?: Record<string, string> | null;
  env_vars?: string[] | null;
  cwd?: string | null;
}

interface RawHttpTransport {
  type: "streamable_http";
  url: string;
  bearer_token_env_var?: string | null;
  http_headers?: Record<string, string> | null;
  env_http_headers?: Record<string, string> | null;
  http_headers_helper?: string | null;
}

type RawTransport = RawStdioTransport | RawHttpTransport;

interface RawServerConfig {
  name: string;
  enabled: boolean;
  disabled_reason?: string | null;
  transport: RawTransport;
  enabled_tools?: string[] | null;
  disabled_tools?: string[] | null;
  startup_timeout_sec?: number | null;
  tool_timeout_sec?: number | null;
  auth_status?: string | null;
}

export interface McpServerConfig extends RawServerConfig {}

export interface McpToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface McpToolInfo {
  callableName: string;
  serverName: string;
  toolName: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpServerStatus {
  name: string;
  transport: "stdio" | "streamable_http";
  state: "disabled" | "ready" | "failed";
  tools: number;
  detail?: string;
}

export interface McpSnapshot {
  tools: readonly McpToolDefinition[];
  instructions: string;
  servers: readonly McpServerStatus[];
}

interface ActiveServer {
  client: Client;
  config: McpServerConfig;
}

interface ActiveTool extends McpToolInfo {
  definition: McpToolDefinition;
  server: ActiveServer;
}

export interface McpRuntimeOptions {
  workspacePath: string;
  version?: string;
  loadConfig?(workspacePath: string, signal?: AbortSignal): Promise<McpServerConfig[]>;
}

export interface McpRuntimeLike {
  ensureReady(signal?: AbortSignal): Promise<McpSnapshot>;
  toolInfo(name: string): McpToolInfo | undefined;
  call(name: string, argumentsJson: string, signal?: AbortSignal): Promise<string>;
}

function secondsToMs(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.round(value * 1000))
    : fallback;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function normalizeConfig(value: unknown): McpServerConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<RawServerConfig>;
  if (typeof raw.name !== "string" || !raw.name.trim()) return undefined;
  if (typeof raw.enabled !== "boolean") return undefined;
  if (!raw.transport || typeof raw.transport !== "object") return undefined;
  const transport = raw.transport as Partial<RawTransport>;
  if (transport.type === "stdio" && typeof transport.command === "string" && transport.command) {
    return {
      name: raw.name,
      enabled: raw.enabled,
      transport: {
        type: "stdio",
        command: transport.command,
        args: Array.isArray(transport.args) ? transport.args.filter((item): item is string => typeof item === "string") : [],
        env: stringRecord(transport.env),
        env_vars: Array.isArray(transport.env_vars) ? transport.env_vars.filter((item): item is string => typeof item === "string") : [],
        cwd: typeof transport.cwd === "string" ? transport.cwd : null,
      },
      ...(typeof raw.disabled_reason === "string" ? { disabled_reason: raw.disabled_reason } : {}),
      ...(Array.isArray(raw.enabled_tools) ? { enabled_tools: raw.enabled_tools.filter((item): item is string => typeof item === "string") } : {}),
      ...(Array.isArray(raw.disabled_tools) ? { disabled_tools: raw.disabled_tools.filter((item): item is string => typeof item === "string") } : {}),
      ...(typeof raw.startup_timeout_sec === "number" ? { startup_timeout_sec: raw.startup_timeout_sec } : {}),
      ...(typeof raw.tool_timeout_sec === "number" ? { tool_timeout_sec: raw.tool_timeout_sec } : {}),
      ...(typeof raw.auth_status === "string" ? { auth_status: raw.auth_status } : {}),
    };
  }
  if (transport.type === "streamable_http" && typeof transport.url === "string") {
    let url: URL;
    try {
      url = new URL(transport.url);
    } catch {
      return undefined;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return {
      name: raw.name,
      enabled: raw.enabled,
      transport: {
        type: "streamable_http",
        url: url.toString(),
        bearer_token_env_var: typeof transport.bearer_token_env_var === "string" ? transport.bearer_token_env_var : null,
        http_headers: stringRecord(transport.http_headers),
        env_http_headers: stringRecord(transport.env_http_headers),
        http_headers_helper: typeof transport.http_headers_helper === "string" ? transport.http_headers_helper : null,
      },
      ...(typeof raw.disabled_reason === "string" ? { disabled_reason: raw.disabled_reason } : {}),
      ...(Array.isArray(raw.enabled_tools) ? { enabled_tools: raw.enabled_tools.filter((item): item is string => typeof item === "string") } : {}),
      ...(Array.isArray(raw.disabled_tools) ? { disabled_tools: raw.disabled_tools.filter((item): item is string => typeof item === "string") } : {}),
      ...(typeof raw.startup_timeout_sec === "number" ? { startup_timeout_sec: raw.startup_timeout_sec } : {}),
      ...(typeof raw.tool_timeout_sec === "number" ? { tool_timeout_sec: raw.tool_timeout_sec } : {}),
      ...(typeof raw.auth_status === "string" ? { auth_status: raw.auth_status } : {}),
    };
  }
  return undefined;
}

export async function loadCodexMcpServers(
  workspacePath: string,
  signal?: AbortSignal,
): Promise<McpServerConfig[]> {
  const listed = await readCodexCliJson<unknown>(["mcp", "list", "--json"], {
    cwd: workspacePath,
    ...(signal ? { signal } : {}),
  });
  if (!Array.isArray(listed)) throw new Error("Codex MCP configuration was not a list");
  const servers: McpServerConfig[] = [];
  for (const entry of listed) {
    const base = normalizeConfig(entry);
    if (!base) continue;
    let detailed = base;
    try {
      const rawDetail = await readCodexCliJson<unknown>(
        ["mcp", "get", base.name, "--json"],
        { cwd: workspacePath, ...(signal ? { signal } : {}) },
      );
      detailed = normalizeConfig({ ...(rawDetail as object), auth_status: base.auth_status }) ?? base;
    } catch {
      // The list output is enough to connect. A concurrently removed server or
      // an older CLI without JSON details should not disable every MCP server.
    }
    servers.push(detailed);
  }
  return servers;
}

function callablePart(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/gu, "_");
  return normalized || "tool";
}

function callableName(server: string, tool: string): string {
  const raw = `mcp__${callablePart(server)}__${callablePart(tool)}`;
  if (raw.length <= 64) return raw;
  const suffix = createHash("sha256").update(raw).digest("hex").slice(0, 10);
  return `${raw.slice(0, 53)}_${suffix}`;
}

function isToolEnabled(config: McpServerConfig, name: string): boolean {
  if (config.enabled_tools && !config.enabled_tools.includes(name)) return false;
  return !config.disabled_tools?.includes(name);
}

function serializeResult(value: unknown): string {
  const serialized = JSON.stringify(value);
  const retained = retainOutput(serialized, MAX_MCP_RESULT_BYTES);
  return retained.truncated
    ? JSON.stringify({ status: "truncated", output: retained.text })
    : serialized;
}

export class McpRuntime {
  #workspacePath: string;
  readonly #version: string;
  readonly #loadConfig: NonNullable<McpRuntimeOptions["loadConfig"]>;
  #loaded = false;
  #loading: Promise<void> | undefined;
  #servers: ActiveServer[] = [];
  #tools = new Map<string, ActiveTool>();
  #statuses: McpServerStatus[] = [];
  #instructions = "";

  constructor(options: McpRuntimeOptions) {
    this.#workspacePath = options.workspacePath;
    this.#version = options.version ?? "0.0.0";
    this.#loadConfig = options.loadConfig ?? loadCodexMcpServers;
  }

  async setWorkspace(workspacePath: string): Promise<void> {
    if (this.#loading) await this.#loading.catch(() => undefined);
    if (workspacePath === this.#workspacePath) return;
    this.#workspacePath = workspacePath;
    this.#loaded = false;
    await this.#closeServers();
  }

  async ensureReady(signal?: AbortSignal): Promise<McpSnapshot> {
    if (!this.#loaded) await this.#load(false, signal);
    return this.snapshot();
  }

  async refresh(signal?: AbortSignal): Promise<McpSnapshot> {
    await this.#load(true, signal);
    return this.snapshot();
  }

  snapshot(): McpSnapshot {
    return {
      tools: [...this.#tools.values()].map((tool) => tool.definition),
      instructions: this.#instructions,
      servers: this.#statuses.map((status) => ({ ...status })),
    };
  }

  toolInfo(name: string): McpToolInfo | undefined {
    const tool = this.#tools.get(name);
    if (!tool) return undefined;
    return {
      callableName: tool.callableName,
      serverName: tool.serverName,
      toolName: tool.toolName,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.annotations ? { annotations: { ...tool.annotations } } : {}),
    };
  }

  async call(name: string, argumentsJson: string, signal?: AbortSignal): Promise<string> {
    await this.ensureReady(signal);
    const tool = this.#tools.get(name);
    if (!tool) return JSON.stringify({ status: "error", error: `MCP tool is unavailable: ${name}` });
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = argumentsJson.trim() ? JSON.parse(argumentsJson) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      args = parsed as Record<string, unknown>;
    } catch {
      return JSON.stringify({ status: "error", error: "Invalid MCP tool arguments" });
    }
    try {
      const result = await tool.server.client.callTool(
        { name: tool.toolName, arguments: args },
        undefined,
        {
          timeout: secondsToMs(tool.server.config.tool_timeout_sec, DEFAULT_TOOL_TIMEOUT_MS),
          ...(signal ? { signal } : {}),
        },
      );
      return serializeResult(result);
    } catch (error) {
      if (signal?.aborted) throw error;
      return JSON.stringify({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async close(): Promise<void> {
    this.#loaded = false;
    await this.#closeServers();
  }

  async #load(force: boolean, signal?: AbortSignal): Promise<void> {
    if (this.#loading) return this.#loading;
    if (this.#loaded && !force) return;
    this.#loading = this.#loadNow(signal).finally(() => {
      this.#loading = undefined;
    });
    return this.#loading;
  }

  async #loadNow(signal?: AbortSignal): Promise<void> {
    await this.#closeServers();
    this.#tools.clear();
    this.#statuses = [];
    this.#instructions = "";
    let configs: McpServerConfig[];
    try {
      configs = await this.#loadConfig(this.#workspacePath, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      this.#statuses = [{
        name: "Codex configuration",
        transport: "stdio",
        state: "failed",
        tools: 0,
        detail: error instanceof Error ? error.message : String(error),
      }];
      this.#loaded = true;
      return;
    }

    for (const config of configs) {
      signal?.throwIfAborted();
      if (!config.enabled) {
        this.#statuses.push({
          name: config.name,
          transport: config.transport.type,
          state: "disabled",
          tools: 0,
          ...(config.disabled_reason ? { detail: config.disabled_reason } : {}),
        });
        continue;
      }
      let active: ActiveServer | undefined;
      try {
        active = await this.#connect(config, signal);
        const tools = await this.#listTools(active, signal);
        let toolCount = 0;
        for (const tool of tools) {
          if (!isToolEnabled(config, tool.name)) continue;
          let name = callableName(config.name, tool.name);
          if (this.#tools.has(name)) {
            const suffix = createHash("sha256").update(`${config.name}\0${tool.name}`).digest("hex").slice(0, 10);
            name = `${name.slice(0, 53)}_${suffix}`;
          }
          const description = tool.description || `MCP tool ${config.name}/${tool.name}`;
          const annotations = tool.annotations
            ? {
                ...(typeof tool.annotations.readOnlyHint === "boolean" ? { readOnlyHint: tool.annotations.readOnlyHint } : {}),
                ...(typeof tool.annotations.destructiveHint === "boolean" ? { destructiveHint: tool.annotations.destructiveHint } : {}),
                ...(typeof tool.annotations.idempotentHint === "boolean" ? { idempotentHint: tool.annotations.idempotentHint } : {}),
                ...(typeof tool.annotations.openWorldHint === "boolean" ? { openWorldHint: tool.annotations.openWorldHint } : {}),
              }
            : undefined;
          const record: ActiveTool = {
            callableName: name,
            serverName: config.name,
            toolName: tool.name,
            description,
            ...(annotations ? { annotations } : {}),
            definition: {
              type: "function",
              name,
              description,
              parameters: tool.inputSchema as Record<string, unknown>,
            },
            server: active,
          };
          this.#tools.set(name, record);
          toolCount++;
        }
        const serverInstructions = active.client.getInstructions()?.trim();
        if (serverInstructions) {
          this.#instructions += `\nMCP server ${config.name} instructions:\n${serverInstructions.slice(0, 512)}`;
        }
        this.#statuses.push({
          name: config.name,
          transport: config.transport.type,
          state: "ready",
          tools: toolCount,
        });
        this.#servers.push(active);
      } catch (error) {
        if (active) await active.client.close().catch(() => undefined);
        if (signal?.aborted) {
          await this.#closeServers();
          this.#tools.clear();
          throw error;
        }
        this.#statuses.push({
          name: config.name,
          transport: config.transport.type,
          state: "failed",
          tools: 0,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.#loaded = true;
  }

  async #connect(config: McpServerConfig, signal?: AbortSignal): Promise<ActiveServer> {
    const client = new Client({ name: "everpeace", version: this.#version });
    const transport = config.transport.type === "stdio"
      ? new StdioClientTransport({
          command: config.transport.command,
          args: config.transport.args ?? [],
          env: {
            ...getDefaultEnvironment(),
            ...Object.fromEntries(
              (config.transport.env_vars ?? []).flatMap((name) => {
                const value = process.env[name];
                return value === undefined ? [] : [[name, value]];
              }),
            ),
            ...(config.transport.env ?? {}),
          },
          cwd: config.transport.cwd
            ? resolve(this.#workspacePath, config.transport.cwd)
            : this.#workspacePath,
          stderr: "pipe",
        })
      : new StreamableHTTPClientTransport(
          new URL(config.transport.url),
          { requestInit: { headers: this.#httpHeaders(config.transport) } },
        );
    if (transport instanceof StdioClientTransport) {
      transport.stderr?.on("data", () => undefined);
    }
    await client.connect(transport as never, {
      timeout: secondsToMs(config.startup_timeout_sec, DEFAULT_STARTUP_TIMEOUT_MS),
      ...(signal ? { signal } : {}),
    });
    return { client, config };
  }

  #httpHeaders(transport: RawHttpTransport): Headers {
    if (transport.http_headers_helper) {
      throw new Error("MCP http_headers_helper is not supported by this runtime");
    }
    const headers = new Headers(transport.http_headers ?? {});
    for (const [header, envName] of Object.entries(transport.env_http_headers ?? {})) {
      const value = process.env[envName];
      if (value !== undefined) headers.set(header, value);
    }
    if (transport.bearer_token_env_var) {
      const token = process.env[transport.bearer_token_env_var];
      if (!token) throw new Error(`MCP bearer token environment variable is missing: ${transport.bearer_token_env_var}`);
      headers.set("authorization", `Bearer ${token}`);
    }
    return headers;
  }

  async #listTools(active: ActiveServer, signal?: AbortSignal) {
    const tools: Array<Awaited<ReturnType<Client["listTools"]>>["tools"][number]> = [];
    let cursor: string | undefined;
    do {
      const page = await active.client.listTools(
        cursor ? { cursor } : undefined,
        {
          timeout: secondsToMs(active.config.startup_timeout_sec, DEFAULT_STARTUP_TIMEOUT_MS),
          ...(signal ? { signal } : {}),
        },
      );
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async #closeServers(): Promise<void> {
    const servers = this.#servers.splice(0);
    await Promise.allSettled(servers.map((server) => server.client.close()));
  }
}

export function formatMcpStatus(snapshot: McpSnapshot): string {
  if (snapshot.servers.length === 0) {
    return "No MCP servers are configured. Add one with `codex mcp add`, then reopen /mcp.";
  }
  return snapshot.servers.map((server) => {
    const detail = server.detail ? ` · ${server.detail}` : "";
    return `${server.name} · ${server.transport} · ${server.state} · ${server.tools} tool${server.tools === 1 ? "" : "s"}${detail}`;
  }).join("\n");
}
