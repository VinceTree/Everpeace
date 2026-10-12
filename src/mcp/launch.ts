import { promises as fs } from "node:fs";
import { delimiter, extname, isAbsolute, resolve } from "node:path";
import { DEFAULT_INHERITED_ENV_VARS, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "./runtime.js";
import { McpPermanentConnectionError } from "./errors.js";

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export async function canonicalWorkspace(workspace: string): Promise<string> {
  const result = await fs.realpath(resolve(workspace));
  return process.platform === "win32" ? result.toLowerCase() : result;
}

export function validateMcpUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new McpPermanentConnectionError("Invalid MCP endpoint URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new McpPermanentConnectionError("MCP requires HTTP(S) without URL credentials or fragments");
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) throw new McpPermanentConnectionError("Non-loopback MCP endpoints require HTTPS");
  return url;
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/u.test(hostname);
}

/** Freeze the exact process environment and executable used after approval. */
export async function prepareMcpConfig(config: McpServerConfig, workspace: string): Promise<McpServerConfig> {
  const copy = structuredClone(config);
  if (copy.transport.type === "streamable_http") {
    copy.transport.url = validateMcpUrl(copy.transport.url).href;
    try {
      const headers = new Headers(copy.transport.http_headers ?? {});
      for (const [header, name] of Object.entries(copy.transport.env_http_headers ?? {})) {
        if (process.env[name] !== undefined) headers.set(header, process.env[name]!);
      }
      if (copy.transport.bearer_token_env_var) {
        const token = process.env[copy.transport.bearer_token_env_var];
        if (!token) throw new McpPermanentConnectionError("MCP bearer token environment variable is missing");
        headers.set("authorization", `Bearer ${token}`);
      }
      copy.transport.resolved_headers = Object.fromEntries(headers.entries());
    } catch { throw new McpPermanentConnectionError("MCP HTTP authentication headers are invalid or unavailable"); }
    return copy;
  }
  const transport = copy.transport;
  const cwd = await fs.realpath(resolve(workspace, transport.cwd ?? "."));
  const inherited = Object.fromEntries((transport.env_vars ?? []).flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  const values = { ...Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((name) => [name, ""])), ...getDefaultEnvironment(), ...inherited, ...transport.env };
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) env[process.platform === "win32" ? name.toUpperCase() : name] = value;
  const command = transport.command;
  const extensions = process.platform === "win32" && !extname(command) ? (env.PATHEXT?.split(";").filter(Boolean) ?? [".COM", ".EXE", ".BAT", ".CMD"]) : [""];
  const candidates = isAbsolute(command) || /[/\\]/u.test(command)
    ? [resolve(cwd, command)]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).flatMap((directory) => extensions.map((extension) => resolve(cwd, directory, `${command}${extension}`)));
  for (const candidate of candidates) {
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      await fs.access(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      transport.command = await fs.realpath(candidate);
      transport.cwd = cwd;
      transport.env = env;
      transport.env_vars = [];
      transport.args ??= [];
      return copy;
    } catch { /* Continue PATH lookup without exposing filesystem errors. */ }
  }
  throw new McpPermanentConnectionError("MCP stdio executable is unavailable");
}

export function mcpTrustKind(config: McpServerConfig): "mcp_start" | "mcp_http" | undefined {
  return config.transport.type === "stdio" ? "mcp_start" : validateMcpUrl(config.transport.url).protocol === "http:" ? "mcp_http" : undefined;
}

/** Secrets enter only the keyed fingerprint, never the preview or trust record. */
export function mcpTrustMaterial(config: McpServerConfig): unknown {
  return config.transport;
}

export function mcpTrustSummary(config: McpServerConfig, workspace: string): string {
  const transport = config.transport;
  const lines = [`Server: ${JSON.stringify(config.name)}`, `Workspace: ${JSON.stringify(workspace)}`, "Source: effective Codex MCP configuration (file origin unknown)"];
  if (transport.type === "stdio") {
    lines.push(`Program: ${JSON.stringify(transport.command)}`, `Arguments: ${(transport.args ?? []).map(() => "<redacted>").join(" ") || "(none)"}`, `Directory: ${JSON.stringify(transport.cwd)}`, `Environment names: ${JSON.stringify(Object.keys(transport.env ?? {}).sort())}`, "Allowing startup means allowing this program to run with your host user permissions. Tool-call approval does not limit this program. This does not verify the program or its dependencies.");
  } else {
    lines.push(`Endpoint: ${new URL(transport.url).origin} (path and query hidden)`, `Header names: ${JSON.stringify([...Object.keys(transport.http_headers ?? {}), ...Object.keys(transport.env_http_headers ?? {}), ...(transport.bearer_token_env_var ? ["Authorization"] : [])])}`, "Allow plaintext HTTP to this local endpoint? Credentials and MCP data can be read by local programs.");
  }
  return lines.join("\n");
}
