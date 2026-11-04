import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { startCodexDuplexProcess, startOwnedDuplexProcess, type CodexDuplexProcess } from '../codex/cli.js';
import { createEffectiveSandboxPolicy, materializeSandboxControlPaths, modelShellEnvironment, nativePermissionProfileArgs } from '../tools/sandbox-policy.js';
import type { McpServerConfig } from './runtime.js';

/** Internal process seam; production always uses the owned launchers. */
export const mcpProcessBackend = { host: startOwnedDuplexProcess, sandbox: startCodexDuplexProcess };

/** MCP framing over the owned duplex launcher, with isolation chosen by approved config. */
export class SandboxedMcpTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  #process?: CodexDuplexProcess;
  #pending = '';
  #close?: Promise<void>;
  #closed = false;
  constructor(readonly config: McpServerConfig, readonly workspace: string) {}
  async start(): Promise<void> {
    if (this.#close || this.#closed) throw new Error('MCP transport is closed');
    if (this.#process) throw new Error('MCP transport already started');
    if (this.config.transport.type !== 'stdio') throw new Error('Expected stdio MCP');
    const transport = this.config.transport;
    if (transport.isolation === 'host') this.#process = mcpProcessBackend.host(transport.command, transport.args ?? [], { cwd: transport.cwd ?? this.workspace, env: transport.env ?? {} });
    else {
      const policy = createEffectiveSandboxPolicy({ mode: transport.sandboxMode ?? 'workspace-write', web: false, shellNetwork: 'deny' }, this.workspace);
      materializeSandboxControlPaths(policy);
      this.#process = mcpProcessBackend.sandbox(['sandbox', ...nativePermissionProfileArgs(policy), '-C', transport.cwd ?? this.workspace, '--sandbox-state-disable-network', '--include-managed-config', '--', transport.command, ...(transport.args ?? [])], { cwd: this.workspace, env: modelShellEnvironment(transport.env ?? {}) });
    }
    this.#process.stdout.setEncoding('utf8');
    this.#process.stdout.on('data', (chunk: string) => {
      this.#pending += chunk;
      if (Buffer.byteLength(this.#pending) > 2 * 1024 * 1024) { this.onerror?.(new Error('MCP frame limit exceeded')); void this.close().catch(error => this.onerror?.(error)); return; }
      let index: number;
      while ((index = this.#pending.indexOf('\n')) >= 0) {
        const line = this.#pending.slice(0, index); this.#pending = this.#pending.slice(index + 1);
        try { this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line))); }
        catch { this.onerror?.(new Error('Invalid MCP JSON-RPC frame')); void this.close().catch(error => this.onerror?.(error)); return; }
      }
    });
    void this.#process.exit.then(result => { if (result.exitCode !== 0 && !this.#close) this.onerror?.(new Error('Owned MCP exited')); this.#notifyClosed(); }, error => { this.onerror?.(error instanceof Error ? error : new Error('MCP cleanup failed')); this.#notifyClosed(); });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.#close || this.#closed) throw new Error('MCP transport is closed');
    const line = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(line) > 2 * 1024 * 1024 || !this.#process) throw new Error('MCP transport unavailable or frame too large');
    await this.#process.write(line);
  }
  #notifyClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onclose?.();
  }
  close(): Promise<void> {
    // Publish the shared close promise before notifying the SDK: its close
    // callback may reenter close(). No process also has a confirmed terminal state.
    return this.#close ??= Promise.resolve().then(async () => { if (this.#process) {
      const process = this.#process;
      let stopping: Promise<unknown> | undefined;
      const stop = () => stopping ??= process.terminate();
      const timer = setTimeout(() => { void stop().catch(() => undefined); }, 100);
      try {
        try { process.closeInput(); await process.exit; }
        catch {
          // Pipe/launch errors are not proof of a live process. The owned
          // termination path still rejects every unresolved cleanup result.
          await stop();
        }
        if (stopping) await stopping;
      } finally { clearTimeout(timer); }
    } else this.#notifyClosed(); });
  }
}
