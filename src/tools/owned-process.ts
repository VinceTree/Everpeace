import { spawn, type SpawnOptions, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { readFileSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CleanupDeadline } from '../util/cleanup-deadline.js';

export type ProcessState = 'confirmed_exited' | 'still_running' | 'unknown';
export interface ProcessReceipt { status: ProcessState; exitCode: number | null; pid?: number; identity?: string; winError?: number }
export interface OwnedProcess {
  readonly ownerId: string;
  receipt: Promise<ProcessReceipt>;
  stop(): void;
  status?(): Promise<ProcessReceipt>;
}
const owners = new Map<number, OwnedProcess>();
export function processOwner(pid: number): OwnedProcess | undefined { return owners.get(pid); }
export interface ProcessOwnerDiagnostic { phase: 'launch' | 'lifetime'; durationMs: number; status: ProcessState; identityDigest?: string; winError?: number }
const diagnostics: ProcessOwnerDiagnostic[] = [];
/** Host-only bounded metadata; never contains argv, cwd, output or environment. */
export function processOwnerDiagnostics(): readonly ProcessOwnerDiagnostic[] { return diagnostics.map(entry => ({ ...entry })); }

export function processHelperPath(): string {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const file = path.join(root, 'native/process/bin', `${process.platform}-${process.arch}`, 'everpeace-process.exe');
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (readFileSync(`${file}.sha256`, 'utf8').trim() !== digest) throw new Error('Native process owner integrity verification failed');
  return file;
}
function field(text: string): Buffer {
  const value = Buffer.from(text); if (value.toString('utf8') !== text || text.includes('\0')) throw new Error('Invalid process launch field');
  const size = Buffer.alloc(4); size.writeUInt32LE(value.length); return Buffer.concat([size, value]);
}
function word(n: number): Buffer { const size = Buffer.alloc(4); size.writeUInt32LE(n); return size; }
function executablePath(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
  if (path.win32.isAbsolute(command) || /[/\\]/u.test(command)) return path.resolve(cwd, command);
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const extensions = path.extname(command) ? [''] : ['.exe', '.com'];
  for (const directory of pathValue.split(';').filter(Boolean)) for (const extension of extensions) {
    const candidate = path.resolve(cwd, directory, command + extension);
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* continue explicit PATH lookup */ }
  }
  throw Object.assign(new Error('Process executable is unavailable: ENOENT'), { code: 'ENOENT' });
}

/** Launch identity travels over an owner-only pipe, never the payload's output. */
export function ownedLaunch(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }): { command: string; args: string[]; attach(pid: number): OwnedProcess } {
  const pipe = `\\\\.\\pipe\\everpeace-owner-${randomUUID()}`;
  const environment = [...new Map(Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => [key.toUpperCase(), value] as const))].sort(([a], [b]) => a.localeCompare(b));
  const cwd = options.cwd ?? process.cwd();
  const executable = executablePath(command, cwd, Object.fromEntries(environment));
  const payload = Buffer.concat([Buffer.from('EPP2'), field(executable), field(cwd), word(args.length), ...args.map(field), word(environment.length), ...environment.map(([key, value]) => field(`${key}=${value}`))]);
  if (payload.length > 1024 * 1024 || args.length > 4096 || environment.length > 4096) throw new Error('Process launch exceeds bounded protocol');
  const helper = processHelperPath();
  return { command: helper, args: ['--pipe', pipe], attach(pid) {
    const startedAt = performance.now();
    let socket: Socket | undefined, stopped = false, finished = false, pending = '', identity: string | undefined, targetPid: number | undefined;
    let resolve!: (receipt: ProcessReceipt) => void;
    let queried: Promise<ProcessReceipt> | undefined, answer: ((value: ProcessReceipt) => void) | undefined;
    const receipt = new Promise<ProcessReceipt>(accept => { resolve = accept; });
    const settle = (value: ProcessReceipt) => {
      if (finished) return; finished = true; clearTimeout(timer); owners.delete(pid); socket?.destroy();
      diagnostics.push({ phase: identity ? 'lifetime' : 'launch', durationMs: Math.round(performance.now() - startedAt), status: value.status, ...(identity ? { identityDigest: createHash('sha256').update(`${pid}:${identity}`).digest('hex').slice(0, 16) } : {}), ...(value.winError === undefined ? {} : { winError: value.winError }) });
      if (diagnostics.length > 128) diagnostics.shift();
      resolve({ ...value, ...(identity ? { identity } : {}), ...(targetPid ? { pid: targetPid } : {}) });
      answer?.(value);
    };
    const timer = setTimeout(() => settle({ status: 'unknown', exitCode: null }), 5000);
    const connect = () => {
      if (finished) return;
      let attempt: Socket;
      try { attempt = createConnection(pipe); } catch { settle({ status: 'unknown', exitCode: null }); return; }
      attempt.once('error', (error: NodeJS.ErrnoException) => {
        attempt.destroy();
        if (finished) return;
        if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') setTimeout(connect, 10);
        else settle({ status: 'unknown', exitCode: null });
      });
      attempt.once('connect', () => {
        if (finished) { attempt.destroy(); return; }
        socket = attempt;
        attempt.write(payload); if (stopped) attempt.write('stop\n');
        attempt.setEncoding('utf8');
        attempt.on('data', (chunk: string) => {
          pending += chunk;
          if (pending.length > 8192) { settle({ status: 'unknown', exitCode: null }); return; }
          let newline: number;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              if (event.event === 'ready' && Number.isInteger(event.pid) && typeof event.identity === 'string') { targetPid = event.pid as number; identity = event.identity; clearTimeout(timer); }
              else if (event.event === 'launch_error' && Number.isInteger(event.winError) && !identity) settle({ status: 'confirmed_exited', exitCode: null, winError: event.winError as number });
              else if (event.event === 'status' && ['confirmed_exited', 'still_running', 'unknown'].includes(String(event.status))) { answer?.({ status: event.status as ProcessState, exitCode: null }); answer = undefined; queried = undefined; }
              else if (event.event === 'exit' && event.status === 'confirmed_exited' && typeof event.exitCode === 'number' && identity) settle({ status: 'confirmed_exited', exitCode: event.exitCode });
              else settle({ status: 'unknown', exitCode: null, ...(typeof event.winError === 'number' ? { winError: event.winError } : {}) });
            } catch { settle({ status: 'unknown', exitCode: null }); }
          }
        });
        attempt.once('close', () => settle({ status: 'unknown', exitCode: null }));
      });
    };
    const owner: OwnedProcess = { ownerId: randomUUID(), receipt,
      status() {
        if (finished) return receipt;
        if (!socket || !identity) return Promise.resolve({ status: 'unknown', exitCode: null });
        if (!queried) { const waiting = new Promise<ProcessReceipt>(resolve => { answer = resolve; }); queried = new CleanupDeadline().wait(waiting, 'process_status').catch(() => ({ status: 'unknown' as const, exitCode: null })); socket.write('status\n'); }
        return queried;
      },
      stop() { if (stopped || finished) return; stopped = true; socket?.write('stop\n'); } };
    owners.set(pid, owner); connect(); return owner;
  } };
}

export function spawnOwned(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcessWithoutNullStreams {
  if (process.platform !== 'win32') return spawn(command, [...args], { ...options, detached: true }) as ChildProcessWithoutNullStreams;
  if (options.shell) throw new Error('Native ownership requires an explicit executable and argv');
  const launch = nativeProcessBackend.launch(command, args, { ...(options.cwd ? { cwd: String(options.cwd) } : {}), ...(options.env ? { env: options.env } : {}) });
  const child = spawn(launch.command, launch.args, { ...options, shell: false, windowsHide: true });
  if (child.pid) { const owner = launch.attach(child.pid); owners.set(child.pid, owner); void owner.receipt.then(receipt => { if (receipt.status !== 'confirmed_exited' && child.exitCode === null && child.signalCode === null) child.kill(); if (owners.get(child.pid!) === owner) owners.delete(child.pid!); }); }
  return child as ChildProcessWithoutNullStreams;
}
/** Internal transport seam for deterministic lifecycle tests, never a model option. */
export const nativeProcessBackend = { launch: ownedLaunch };
