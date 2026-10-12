import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { safeCommitFile, safeReadFile, safeListDirectory, safeWorkspaceIdentity, SafeFileError } from './safe-files.js';
import { ResourceCleanupError } from '../util/resource-cleanup-error.js';

export interface ByteChange { path: string; before?: Buffer; after?: Buffer; beforeIdentity?: string; attributes?: number; restoreAttributes?: number }
export type BatchState = 'committed' | 'rolled_back' | 'partial' | 'conflict' | 'unknown';
export interface BatchResult { id: string; state: BatchState; identities: Array<string | null>; conflicts: string[]; error?: unknown; outcomes?: Array<{ path: string; state: 'untouched' | 'rolled_back' | 'committed' | 'conflict' | 'unknown' }> }
interface Entry { path: string; token: string; before: string | null; after: string | null; beforeIdentity: string | null; attributes?: number }
interface Manifest { version: 1; id: string; rootIdentity: string; operations: Entry[] }
interface FileJournal { path: string; before: Buffer; after: Buffer; beforeIdentity: string; installedIdentity: string; rootIdentity: string; beforeExists: boolean; afterExists: boolean; stage?: string }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const token = () => randomUUID().replaceAll('-', '');
const prefix = (id: string) => `.everpeace-batch-${id}`;
const backup = (entry: { path: string; token: string }) => `${entry.path}.everpeace-recovery-${entry.token}.bak`;
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const digest = (value: { exists: boolean; bytes: Buffer }) => value.exists ? hash(value.bytes) : null;
async function create(workspace: string, file: string, bytes: Buffer) { await safeCommitFile(workspace, file, undefined, bytes); }
async function erase(workspace: string, file: string, expected?: { bytes?: Buffer; identity?: string; hash?: string | null }) { const value = await safeReadFile(workspace, file); if (value.exists) { if (expected?.bytes && !value.bytes.equals(expected.bytes) || expected?.identity && value.identity !== expected.identity || expected?.hash !== undefined && hash(value.bytes) !== expected.hash) throw new SafeFileError('FILE_CONFLICT'); await safeCommitFile(workspace, file, value.bytes, undefined, undefined, undefined, value.identity); } }
export function parseFileJournal(bytes: Buffer): FileJournal {
  if (bytes.subarray(0, 4).toString() !== 'EPJ3') throw new SafeFileError('POLICY_DENIED');
  let offset = 4;
  const read = () => { if (offset + 4 > bytes.length) throw new SafeFileError('POLICY_DENIED'); const size = bytes.readUInt32LE(offset); offset += 4; if (size > 64 * 1024 * 1024 || offset + size > bytes.length) throw new SafeFileError('POLICY_DENIED'); const field = bytes.subarray(offset, offset + size); offset += size; return field; };
  const file = read().toString('utf8'), before = read(), after = read(), beforeIdentity = read().toString(), installedIdentity = read().toString(), rootIdentity = read().toString(), beforeExists = read().toString(), afterExists = read().toString();
  const stage = offset < bytes.length ? read().toString('utf8') : '';
  if (offset !== bytes.length || !['0', '1'].includes(beforeExists) || !['0', '1'].includes(afterExists) || stage && (!stage.startsWith(file + '.everpeace-stage-') || !/\.everpeace-stage-[a-f0-9]{32}\.tmp$/u.test(stage) || path.dirname(stage) !== path.dirname(file))) throw new SafeFileError('POLICY_DENIED');
  return { path: file, before, after, beforeIdentity, installedIdentity, rootIdentity, beforeExists: beforeExists === '1', afterExists: afterExists === '1', ...(stage ? { stage } : {}) };
}
async function journal(workspace: string, entry: { path: string; token: string }, rootIdentity: string): Promise<FileJournal | undefined> {
  const value = await safeReadFile(workspace, `${backup(entry)}.journal`);
  if (!value.exists) return undefined;
  const parsed = parseFileJournal(value.bytes);
  if (parsed.path !== path.normalize(entry.path) || parsed.rootIdentity !== rootIdentity) throw new SafeFileError('POLICY_DENIED');
  return parsed;
}
async function manifest(workspace: string, id: string): Promise<Manifest> {
  if (!/^[a-f0-9]{32}$/u.test(id)) throw new SafeFileError('POLICY_DENIED');
  const value = await safeReadFile(workspace, `${prefix(id)}.json`);
  if (!value.exists || value.bytes.length > 128 * 1024) throw new SafeFileError('POLICY_DENIED');
  const data = JSON.parse(value.bytes.toString('utf8')) as Manifest;
  const validHash = (v: unknown) => v === null || typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
  if (data.version !== 1 || data.id !== id || data.rootIdentity !== await safeWorkspaceIdentity(workspace) || !Array.isArray(data.operations) || !data.operations.length || data.operations.length > 20 || new Set(data.operations.map(op => op.path.toLowerCase())).size !== data.operations.length || data.operations.some(op => !op || typeof op.path !== 'string' || !op.path || path.isAbsolute(op.path) || op.path.split(/[\\/]/u).some(part => !part || part === '..' || part === '.' || part.includes(':') || part.startsWith('.everpeace-batch-')) || !/^[a-f0-9]{32}$/u.test(op.token) || !validHash(op.before) || !validHash(op.after) || op.before === null && op.after === null || op.before !== null && (typeof op.beforeIdentity !== 'string' || !/^\d+:\d+:\d+$/u.test(op.beforeIdentity)) || op.attributes !== undefined && (!Number.isInteger(op.attributes) || op.attributes < 0 || op.attributes > 0xffffffff))) throw new SafeFileError('POLICY_DENIED');
  return data;
}
async function bytes(workspace: string, id: string, index: number, side: 'before' | 'after', expected: string | null): Promise<Buffer | undefined> {
  if (expected === null) return undefined;
  const value = await safeReadFile(workspace, `${prefix(id)}.${index}.${side}`);
  if (!value.exists || hash(value.bytes) !== expected) throw new SafeFileError('POLICY_DENIED');
  return value.bytes;
}
async function rollbackRecords(workspace: string, id: string, index: number): Promise<Array<{ path: string; token: string }>> {
  const records: Array<{ path: string; token: string }> = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    const value = await safeReadFile(workspace, `${prefix(id)}.${index}.rollback${attempt}`);
    if (!value.exists) break;
    if (value.bytes.length > 4096) throw new SafeFileError('POLICY_DENIED');
    const record = JSON.parse(value.bytes.toString()) as { path: string; token: string };
    if (typeof record.path !== 'string' || !/^[a-f0-9]{32}$/u.test(record.token)) throw new SafeFileError('POLICY_DENIED');
    records.push(record);
  }
  return records;
}
async function clean(workspace: string, data: Manifest) {
  for (const [index, entry] of data.operations.entries()) {
    const records = await rollbackRecords(workspace, data.id, index);
    for (const record of [entry, ...records]) {
      if (record.path !== entry.path) throw new SafeFileError('POLICY_DENIED');
      // These are private artifacts; native deletion still binds current identity and bytes.
      const metadata = await journal(workspace, record, data.rootIdentity);
      if (metadata?.stage) await erase(workspace, metadata.stage, { bytes: metadata.after, identity: metadata.installedIdentity });
      if (!metadata && (await safeReadFile(workspace, backup(record))).exists) throw new SafeFileError('FILE_CONFLICT');
      if (!metadata && record === entry) await erase(workspace, `${record.path}.everpeace-stage-${record.token}.tmp`, { hash: entry.after });
      await erase(workspace, backup(record), metadata ? { bytes: metadata.before, identity: metadata.beforeIdentity } : undefined); await erase(workspace, `${backup(record)}.journal`);
    }
    for (let attempt = 0; attempt < records.length; attempt++) await erase(workspace, `${prefix(data.id)}.${index}.rollback${attempt}`);
    for (const side of ['before', 'after'] as const) await erase(workspace, `${prefix(data.id)}.${index}.${side}`, { hash: entry[side] });
  }
  await erase(workspace, `${prefix(data.id)}.json`);
  for (const state of ['committed', 'rolled_back']) await erase(workspace, `${prefix(data.id)}.${state}`);
}

/** Shared by patches, undo and team byte integration. Never a filesystem transaction. */
export async function runFileBatch(workspace: string, changes: readonly ByteChange[], options: { signal?: AbortSignal; beforeCommit?(path: string): Promise<void>; maxBytes?: number; id?: string; retainCommitted?: boolean } = {}): Promise<BatchResult> {
  const id = options.id ?? token(); const identities: Array<string | null> = [];
  if (!/^[a-f0-9]{32}$/u.test(id)) throw new SafeFileError('POLICY_DENIED');
  if (!changes.length || changes.length > 20 || new Set(changes.map(op => op.path.toLowerCase())).size !== changes.length || changes.reduce((n, op) => n + (op.before?.length ?? 0) + (op.after?.length ?? 0), 0) > (options.maxBytes ?? 64 * 1024 * 1024)) throw new Error('File batch resource limit exceeded');
  const data: Manifest = { version: 1, id, rootIdentity: await safeWorkspaceIdentity(workspace), operations: changes.map(op => ({ path: op.path, token: token(), before: op.before === undefined ? null : hash(op.before), after: op.after === undefined ? null : hash(op.after), beforeIdentity: op.beforeIdentity ?? null, ...(op.attributes === undefined ? {} : { attributes: op.attributes }) })) };
  // The manifest is immutable; state and rollback intentions are append-only.
  await create(workspace, `${prefix(id)}.json`, json(data));
  try {
    for (const [index, op] of changes.entries()) {
      options.signal?.throwIfAborted();
      if (op.before) await create(workspace, `${prefix(id)}.${index}.before`, op.before);
      if (op.after) await create(workspace, `${prefix(id)}.${index}.after`, op.after);
    }
    for (const [index, op] of changes.entries()) {
      options.signal?.throwIfAborted(); await options.beforeCommit?.(op.path);
      const result = await safeCommitFile(workspace, op.path, op.before, op.after, options.signal, op.restoreAttributes, op.beforeIdentity, data.operations[index]!.token);
      identities.push(result.identity ?? null);
    }
    await create(workspace, `${prefix(id)}.committed`, Buffer.alloc(0));
  } catch (error) {
    if (error instanceof ResourceCleanupError) throw error;
    const recovered = await recoverFileBatch(workspace, id, undefined, options.retainCommitted).catch(recoveryError => { if (recoveryError instanceof ResourceCleanupError) throw recoveryError; return { id, state: 'unknown' as const, identities: [], conflicts: changes.map(op => op.path), error: recoveryError }; });
    return { ...recovered, identities, error };
  }
  try { if (!options.retainCommitted) await clean(workspace, data); }
  catch (error) { if (error instanceof ResourceCleanupError) throw error; return { id, state: 'committed', identities, conflicts: [], error }; }
  return { id, state: 'committed', identities, conflicts: [] };
}
export async function cleanFileBatch(workspace: string, id: string): Promise<void> { const data = await manifest(workspace, id); if (!(await safeReadFile(workspace, `${prefix(id)}.committed`)).exists && !(await safeReadFile(workspace, `${prefix(id)}.rolled_back`)).exists) throw new SafeFileError('FILE_CONFLICT'); await clean(workspace, data); }
export async function describeFileBatch(workspace: string, id: string) { const data = await manifest(workspace, id); return { id, digest: hash(json(data)), operations: data.operations.map(op => ({ path: op.path, before: op.before, after: op.after })) }; }

export async function listFileBatches(workspace: string): Promise<Array<{ id: string; state: 'pending' | 'committed' | 'rolled_back' | 'unknown'; files: number }>> {
  const entries = await safeListDirectory(workspace, ''); const result: Array<{ id: string; state: 'pending' | 'committed' | 'rolled_back' | 'unknown'; files: number }> = [];
  for (const entry of entries) {
    const matched = /^\.everpeace-batch-([a-f0-9]{32})\.json$/u.exec(entry.name); if (!matched) continue;
    const id = matched[1]!;
    try { const data = await manifest(workspace, id); const committed = await safeReadFile(workspace, `${prefix(id)}.committed`); const reverted = await safeReadFile(workspace, `${prefix(id)}.rolled_back`); result.push({ id, state: committed.exists ? 'committed' : reverted.exists ? 'rolled_back' : 'pending', files: data.operations.length }); }
    catch (error) { if (error instanceof ResourceCleanupError) throw error; result.push({ id, state: 'unknown', files: 0 }); }
    if (result.length >= 100) break;
  }
  return result;
}
export async function recoverFileBatch(workspace: string, id: string, guard?: () => Promise<void>, retain = false): Promise<BatchResult> {
  const data = await manifest(workspace, id); const conflicts: string[] = [];
  const outcomes: NonNullable<BatchResult['outcomes']> = [];
  for (const state of ['committed', 'rolled_back'] as const) {
    const marker = await safeReadFile(workspace, `${prefix(id)}.${state}`);
    if (marker.exists) {
      if (marker.bytes.length) throw new SafeFileError('POLICY_DENIED');
      const identities = state === 'committed' ? await Promise.all(data.operations.map(async op => (await journal(workspace, op, data.rootIdentity))?.installedIdentity || null)) : [];
      if (!retain) await clean(workspace, data); return { id, state, identities, conflicts };
    }
  }
  for (const [index, op] of [...data.operations.entries()].reverse()) {
    try {
      const current = await safeReadFile(workspace, op.path);
      const currentHash = digest(current);
      if (currentHash === op.before && (current.identity ?? null) === op.beforeIdentity) { outcomes.push({ path: op.path, state: 'untouched' }); continue; }
      const forward = await journal(workspace, op, data.rootIdentity);
      if (!forward || forward.beforeIdentity !== (op.beforeIdentity ?? '') || (forward.beforeExists ? hash(forward.before) : null) !== op.before || (forward.afterExists ? hash(forward.after) : null) !== op.after) throw new SafeFileError('FILE_CONFLICT');
      const records = await rollbackRecords(workspace, id, index);
      let restored = false, interruptedRollback = false;
      for (const record of records) {
        if (record.path !== op.path) throw new SafeFileError('POLICY_DENIED');
        const inverse = await journal(workspace, record, data.rootIdentity);
        if (!inverse) continue;
        if ((inverse.afterExists ? hash(inverse.after) : null) !== op.before) throw new SafeFileError('POLICY_DENIED');
        if (currentHash === op.before && (current.identity ?? '') === inverse.installedIdentity) restored = true;
        if (!current.exists && inverse.beforeExists) {
          const saved = await safeReadFile(workspace, backup(record));
          if (saved.exists && saved.identity === inverse.beforeIdentity && saved.bytes.equals(inverse.before)) interruptedRollback = true;
        }
      }
      if (restored) { outcomes.push({ path: op.path, state: 'rolled_back' }); continue; }
      const retainedOriginal = await safeReadFile(workspace, backup(op));
      const movedBeforeInstall = !current.exists && forward.beforeExists && retainedOriginal.exists && retainedOriginal.identity === forward.beforeIdentity && retainedOriginal.bytes.equals(forward.before);
      if (!interruptedRollback && !movedBeforeInstall && (currentHash !== op.after || (current.identity ?? '') !== forward.installedIdentity)) throw new SafeFileError('FILE_CONFLICT');
      if (records.length >= 10) throw new SafeFileError('FILE_ACCESS_UNAVAILABLE');
      const original = await bytes(workspace, id, index, 'before', op.before);
      const record = { path: op.path, token: token() };
      await create(workspace, `${prefix(id)}.${index}.rollback${records.length}`, json(record));
      await guard?.();
      await safeCommitFile(workspace, op.path, current.exists ? current.bytes : undefined, original, undefined, op.attributes, current.identity, record.token);
      outcomes.push({ path: op.path, state: 'rolled_back' });
    } catch (error) { if (error instanceof ResourceCleanupError) throw error; conflicts.push(op.path); outcomes.push({ path: op.path, state: error instanceof SafeFileError && (error.code === 'FILE_CONFLICT' || error.code === 'STALE_VERSION') ? 'conflict' : 'unknown' }); }
  }
  if (conflicts.length) return { id, state: outcomes.some(op => op.state === 'unknown') ? 'unknown' : 'conflict', identities: [], conflicts, outcomes };
  await create(workspace, `${prefix(id)}.rolled_back`, Buffer.alloc(0)); if (!retain) await clean(workspace, data);
  return { id, state: 'rolled_back', identities: [], conflicts: [], outcomes };
}
