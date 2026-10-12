import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { startCodexDuplexProcess, type CodexDuplexProcess } from '../codex/cli.js';
import { createEffectiveSandboxPolicy, materializeSandboxControlPaths, modelShellEnvironment, nativePermissionProfileArgs } from '../tools/sandbox-policy.js';
import type { McpServerConfig } from './runtime.js';

/** MCP newline framing over the existing native sandbox duplex process owner. */
export class SandboxedMcpTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  #process?: CodexDuplexProcess;
  #pending = '';
  #close?: Promise<void>;
  constructor(readonly config: McpServerConfig, readonly workspace: string) {}
  async start(): Promise<void> {
    if (this.#process) throw new Error('MCP transport already started');
    if (this.config.transport.type !== 'stdio') throw new Error('Expected stdio MCP');
    const transport = this.config.transport;
    const policy = createEffectiveSandboxPolicy({ mode: transport.sandboxMode ?? 'workspace-write', web: false, shellNetwork: 'deny' }, this.workspace);
    materializeSandboxControlPaths(policy);
    this.#process = startCodexDuplexProcess(['sandbox', ...nativePermissionProfileArgs(policy), '-C', transport.cwd ?? this.workspace, '--sandbox-state-disable-network', '--include-managed-config', '--', transport.command, ...(transport.args ?? [])], { cwd: this.workspace, env: modelShellEnvironment(transport.env ?? {}) });
    this.#process.stdout.setEncoding('utf8');
    this.#process.stdout.on('data', (chunk: string) => {
      this.#pending += chunk;
      if (Buffer.byteLength(this.#pending) > 2 * 1024 * 1024) { this.onerror?.(new Error('MCP frame limit exceeded')); void this.close(); return; }
      let index: number;
      while ((index = this.#pending.indexOf('\n')) >= 0) {
        const line = this.#pending.slice(0, index); this.#pending = this.#pending.slice(index + 1);
        try { this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line))); }
        catch { this.onerror?.(new Error('Invalid MCP JSON-RPC frame')); void this.close(); return; }
      }
    });
    void this.#process.exit.then(result => { if (result.exitCode !== 0 && !this.#close) this.onerror?.(new Error('Sandboxed MCP exited')); this.onclose?.(); }, error => { this.onerror?.(error instanceof Error ? error : new Error('MCP cleanup failed')); this.onclose?.(); });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    const line = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(line) > 2 * 1024 * 1024 || !this.#process) throw new Error('MCP transport unavailable or frame too large');
    await this.#process.write(line);
  }
  close(): Promise<void> {
    return this.#close ??= (async () => { if (this.#process) {
      const process = this.#process; process.closeInput();
      let stopping: Promise<unknown> | undefined;
      const timer = setTimeout(() => { stopping = process.terminate(); void stopping.catch(() => undefined); }, 100);
      try { await process.exit; if (stopping) await stopping; } finally { clearTimeout(timer); }
    } })();
  }
}
