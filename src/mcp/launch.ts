import { createHash } from "node:crypto";
import { scanSensitiveText } from "../util/sensitive-scan.js";
import { safeApprovalText } from "../permissions/sensitive-access.js";
import { promises as fs } from "node:fs";
import { delimiter, extname, isAbsolute, resolve, dirname } from "node:path";
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
  if (transport.isolation !== undefined && transport.isolation !== 'sandbox' && transport.isolation !== 'host') throw new McpPermanentConnectionError('Invalid MCP isolation mode');
  transport.isolation ??= 'sandbox';
  // oxlint-disable-next-line no-control-regex -- Reject terminal controls before displaying launch arguments.
  if ([transport.command, ...(transport.args ?? [])].some(value => /[\u0000-\u001f\u007f-\u009f]/u.test(value))) throw new McpPermanentConnectionError('MCP command or arguments contain control characters');
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
      const files: Array<{ path: string; sha256: string }> = [];
      const hash = async (file: string) => {
        const real = await fs.realpath(file);
        const handle = await fs.open(real, 'r');
        try {
          const metadata = await handle.stat();
          if (!metadata.isFile() || metadata.size > 256 * 1024 * 1024) throw new Error('launch material too large');
          const digest = createHash('sha256'); const chunk = Buffer.alloc(64 * 1024); let total = 0;
          for (;;) { const result = await handle.read(chunk); if (!result.bytesRead) break; total += result.bytesRead; if (total > 256 * 1024 * 1024) throw new Error('launch material too large'); digest.update(chunk.subarray(0, result.bytesRead)); }
          files.push({ path: real, sha256: digest.digest('hex') });
        } finally { await handle.close(); }
      };
      await hash(transport.command);
      for (const arg of transport.args) if (/\.(?:[cm]?js|ts|py|cmd|bat|ps1)$/iu.test(arg) && !arg.startsWith('-')) await hash(resolve(cwd, arg));
      for (const directory of new Set([cwd, dirname(transport.command), ...files.slice(1).map(file => dirname(file.path))])) for (const name of ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']) {
        const file = resolve(directory, name); try { await fs.access(file); } catch { continue; } await hash(file);
      }
      transport.launchIdentity = { files, persistent: !/(?:^|[/\\])(?:npx|npm|pnpm|yarn|uvx)(?:\.(?:cmd|exe))?$/iu.test(transport.command) };
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
    lines.push(`Program: ${JSON.stringify(transport.command)}`, `Arguments: ${safeMcpArguments(transport.args ?? [], transport.launchIdentity?.files.map(file => file.path) ?? [], transport.cwd ?? undefined).join(" ") || "(none)"}`, `Directory: ${JSON.stringify(transport.cwd)}`, `Environment names: ${JSON.stringify(Object.keys(transport.env ?? {}).sort())}`, `Isolation: ${transport.isolation ?? "sandbox"}. ${transport.isolation === "host" ? "Runs with your host user permissions. HOST USER AUTHORITY: tool approval does not isolate this process." : "Native workspace sandbox; network denied; filtered environment."} Startup identity: ${transport.launchIdentity?.files.length ?? 0} files. Transitive dependency integrity is not verified. ${transport.launchIdentity?.persistent === false ? "Dynamic launcher: approval is valid for one startup only." : "Changed launch material requires new approval."}`);
  } else {
    lines.push(`Endpoint: ${new URL(transport.url).origin} (path and query hidden)`, `Header names: ${JSON.stringify([...Object.keys(transport.http_headers ?? {}), ...Object.keys(transport.env_http_headers ?? {}), ...(transport.bearer_token_env_var ? ["Authorization"] : [])])}`, "Allow plaintext HTTP to this local endpoint? Credentials and MCP data can be read by local programs.");
  }
  return lines.join("\n");
}

/** Unknown positional values are hidden; safe options remain useful for review. */
export function safeMcpArguments(args: readonly string[], verifiedPaths: readonly string[] = [], cwd?: string): string[] {
  let secretNext = false;
  return args.map(value => {
    const secret = secretNext; secretNext = /^(?:--?)(?:token|api[-_]?key|password|secret|authorization|credential)$/iu.test(value);
    if (secret || scanSensitiveText(value).length || /(?:token|key|secret|password|auth)[=_]/iu.test(value)) return '<redacted>';
    if (/^--?[a-z][a-z0-9_-]*(?:=(?:true|false|[0-9]+))?$/iu.test(value)) return JSON.stringify(value);
    if ((verifiedPaths.includes(value) || cwd && verifiedPaths.includes(resolve(cwd, value))) && !scanSensitiveText(value).length) return JSON.stringify(value);
    if (/^(?:stdio|--|[0-9]+)$/u.test(value)) return JSON.stringify(value);
    return '<redacted>';
  }).map(safeApprovalText);
}
