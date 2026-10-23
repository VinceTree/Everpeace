import { ToolFeedbackError } from "./tool-feedback.js";
import { spawnOwned as spawn } from './owned-process.js';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeProcessCompletion } from './process-completion.js';

export class SafeFileError extends ToolFeedbackError {
  constructor(readonly code: 'STALE_VERSION' | 'FILE_CONFLICT' | 'POLICY_DENIED' | 'FILE_ACCESS_UNAVAILABLE', readonly recoveryPath?: string, message?: string) {
    super(code, message ?? `Safe file access: ${code}${recoveryPath ? '; original file retained for recovery' : ''}`, code === 'POLICY_DENIED' ? 'Respect the workspace and protected-file boundary; do not bypass through another tool.' : code === 'FILE_ACCESS_UNAVAILABLE' ? 'A verified native file helper and supported local NTFS workspace are required. No host fallback is available.' : 'Re-read the current file. Preserve concurrent user changes; use explicit recovery for retained originals.');
  }
}

const MAX = 64 * 1024 * 1024;
interface NativeFileResult { exists: boolean; bytes: Buffer; identity?: string; attributes?: number; extra: Buffer }
function word(value: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; }
function field(value: Uint8Array | string): Buffer { const b = Buffer.from(value); if (b.length > MAX || typeof value === 'string' && b.toString('utf8') !== value) throw new SafeFileError('POLICY_DENIED'); return Buffer.concat([word(b.length), b]); }

const workspacePins = new Map<string, Promise<string>>();
async function request(op: number, workspace: string, relative: string, before?: Uint8Array, after?: Uint8Array, signal?: AbortSignal, attributes?: number, expectedIdentity?: string, retained?: string): Promise<NativeFileResult> {
  if (process.platform !== 'win32') throw new SafeFileError('FILE_ACCESS_UNAVAILABLE');
  const key = path.resolve(workspace).toLowerCase();
  let pin = workspacePins.get(key);
  if (!pin) {
    pin = nativeRequest(5, workspace, '', '', undefined, undefined, signal).then(result => {
      if (!result.identity || !/^\d+:\d+:\d+$/u.test(result.identity)) throw new SafeFileError('FILE_ACCESS_UNAVAILABLE');
      return result.identity;
    });
    workspacePins.set(key, pin);
    void pin.catch(() => { if (workspacePins.get(key) === pin) workspacePins.delete(key); });
  }
  return nativeRequest(op, workspace, relative, await pin, before, after, signal, attributes, expectedIdentity, retained);
}

async function nativeRequest(op: number, workspace: string, relative: string, rootIdentity: string, before?: Uint8Array, after?: Uint8Array, signal?: AbortSignal, attributes?: number, expectedIdentity?: string, retained?: string): Promise<NativeFileResult> {
  signal?.throwIfAborted();
  if (process.platform !== 'win32') throw new SafeFileError('FILE_ACCESS_UNAVAILABLE');
  const root = path.resolve(workspace);
  const target = path.resolve(root, relative);
  const scoped = path.relative(root, target);
  if (path.isAbsolute(scoped) || scoped === '..' || scoped.startsWith(`..${path.sep}`) || scoped.includes(':')) throw new SafeFileError('POLICY_DENIED');
  const executable = fileURLToPath(new URL(`../../native/files/bin/win32-${process.arch}/everpeace-files.exe`, import.meta.url));
  // dist/tools has the same depth as src/tools. No PATH or host-shell fallback.
  try {
    const digest = createHash('sha256').update(await fs.readFile(executable)).digest('hex');
    if (digest !== (await fs.readFile(`${executable}.sha256`, 'utf8')).trim()) throw new Error('identity mismatch');
  } catch { throw new SafeFileError('FILE_ACCESS_UNAVAILABLE'); }
  const input = Buffer.concat([Buffer.from('EPF3'), word(op), field(root), field(scoped), field(rootIdentity), field(expectedIdentity ?? ''), field(before ?? Buffer.alloc(0)), field(after ?? Buffer.alloc(0)), word(before === undefined ? 0 : 1), word(attributes ?? 0), field(retained ?? '')]);
  const child = spawn(executable, [], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const owned = observeProcessCompletion(child, { ...(signal ? { signal } : {}), timeoutMs: 10_000 });
  const chunks: Buffer[] = []; let bytes = 0;
  child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX + 256 * 1024) owned.stop(); else chunks.push(chunk); });
  child.stderr.on('data', (chunk: Buffer) => { if (process.env.EVERPEACE_NATIVE_DIAGNOSTIC === '1') process.stderr.write(chunk); });
  if (child.stdin) { child.stdin.on('error', () => undefined); child.stdin.end(input); }
  const result = await owned.completion;
  if (result.cleanupError) throw result.cleanupError;
  if (result.error) throw result.error;
  signal?.throwIfAborted();
  if (result.error || result.cleanupError || result.exitCode !== 0 || bytes > MAX + 256 * 1024) throw new SafeFileError('FILE_ACCESS_UNAVAILABLE');
  const output = Buffer.concat(chunks);
  if (output.length < 12) throw new SafeFileError('FILE_ACCESS_UNAVAILABLE');
  const code = output.readUInt32LE(0); const length = output.readUInt32LE(4);
  if (length > MAX || output.length < 12 + length) throw new SafeFileError('FILE_ACCESS_UNAVAILABLE');
  const recoveryLength = output.readUInt32LE(8 + length);
  if (recoveryLength > 256 * 1024 || output.length !== 12 + length + recoveryLength) throw new SafeFileError('FILE_ACCESS_UNAVAILABLE');
  const recovery = output.subarray(12 + length).toString('utf8');
  if (code > 1) throw new SafeFileError(code === 2 ? 'STALE_VERSION' : code === 3 || code === 5 ? 'FILE_CONFLICT' : code === 6 || code === 7 ? 'FILE_ACCESS_UNAVAILABLE' : 'POLICY_DENIED', recovery || undefined, code === 7 ? 'File exceeds the native read limit' : undefined);
  const metadata = op < 3 && recovery ? recovery.split('|') : undefined;
  if (metadata && (metadata.length !== 2 || !/^\d+:\d+:\d+$/u.test(metadata[0]!) || !/^\d{1,10}$/u.test(metadata[1]!) || Number(metadata[1]) > 0xffffffff)) throw new SafeFileError('FILE_ACCESS_UNAVAILABLE');
  return { exists: code !== 1, bytes: output.subarray(8, 8 + length), extra: output.subarray(12 + length), ...(metadata ? { identity: metadata[0]!, attributes: Number(metadata[1]) } : op === 5 && recovery ? { identity: recovery } : {}) };
}

export const safeReadFile = (workspace: string, relative: string, signal?: AbortSignal) => request(0, workspace, relative, undefined, undefined, signal);
export async function safeCommitFile(workspace: string, relative: string, before: Uint8Array | undefined, after: Uint8Array | undefined, signal?: AbortSignal, attributes?: number, expectedIdentity?: string, retained?: string): Promise<{ identity?: string }> {
  const result = await request(after === undefined ? 3 : before === undefined ? 1 : 2, workspace, relative, before, after, signal, attributes, expectedIdentity, retained);
  return result.identity ? { identity: result.identity } : {};
}
export async function safeWorkspaceIdentity(workspace: string): Promise<string> { const result = await request(5, workspace, ''); if (!result.identity) throw new SafeFileError('FILE_ACCESS_UNAVAILABLE'); return result.identity; }
export async function safeListDirectory(workspace: string, relative: string, signal?: AbortSignal): Promise<Array<{ name: string; type: string }>> {
  return (await safeReadDirectory(workspace, relative, signal)).entries;
}
export async function safeReadDirectory(workspace: string, relative: string, signal?: AbortSignal): Promise<{ entries: Array<{ name: string; type: string }>; ignores: string[] }> {
  const { bytes, extra } = await request(4, workspace, relative, undefined, undefined, signal);
  const entries = bytes.toString('utf8').split('\n').filter(Boolean).map((line) => { const index = line.lastIndexOf('\t'); return { name: line.slice(0, index), type: line.slice(index + 1) }; });
  const ignores: string[] = []; let offset = 0;
  for (let i = 0; i < 3; i++) {
    if (offset + 4 > extra.length) throw new SafeFileError('FILE_ACCESS_UNAVAILABLE');
    const size = extra.readUInt32LE(offset); offset += 4;
    if (size > 64 * 1024 || offset + size > extra.length) throw new SafeFileError('FILE_ACCESS_UNAVAILABLE');
    ignores.push(extra.subarray(offset, offset + size).toString('utf8')); offset += size;
  }
  if (offset !== extra.length) throw new SafeFileError('FILE_ACCESS_UNAVAILABLE');
  return { entries, ignores };
}
