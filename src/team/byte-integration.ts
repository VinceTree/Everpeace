import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ApplyPatchResult } from '../tools/apply-patch.js';
import { isProtectedPatchPath } from '../tools/sandbox-policy.js';
import { safeReadFile, safeCommitFile, SafeFileError } from '../tools/safe-files.js';
import { ResourceCleanupError } from '../util/resource-cleanup-error.js';
import { loadTeamWorkspace, type TeamWorkspaceRecord } from './workspace.js';
import { safeTeamPath, TEAM_TOTAL_LIMIT } from './file-artifacts.js';

export interface TeamByteOperation { path: string; action: 'create'|'update'|'delete'; beforeHash: string|null; afterHash: string|null }
interface JournalOperation extends TeamByteOperation { beforeIdentity?: string|null; installedIdentity?: string|null; beforeAttributes?: number }
interface Journal { version: 1|2; source: string; workspace: string; state: 'prepared'|'committed'|'recovered'; operations: JournalOperation[] }
type Guard = () => void|Promise<void>;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const identity = (value: unknown) => value === null || typeof value === 'string' && /^\d+:\d+:\d+$/u.test(value);
function validOperation(op: TeamByteOperation): boolean { const valid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); return op.action === 'create' ? op.beforeHash === null && valid(op.afterHash) : op.action === 'delete' ? valid(op.beforeHash) && op.afterHash === null : op.action === 'update' && valid(op.beforeHash) && valid(op.afterHash); }
function authorized(name: string, scopes: readonly string[]): boolean { const file = process.platform === 'win32' ? name.toLowerCase() : name; return !isProtectedPatchPath(name) && scopes.some(p => { const scope = process.platform === 'win32' ? p.toLowerCase() : p; return scope === '.' || file === scope || file.startsWith(scope.replace(/\/$/u, '') + '/'); }); }
async function directory(record: TeamWorkspaceRecord, id: string): Promise<string> { if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error('Invalid integration owner'); await loadTeamWorkspace(record.workspace, record.source); const transactions = await safeTeamPath(record.owner, 'transactions'); await fs.mkdir(transactions, { recursive: true }); const root = await safeTeamPath(record.owner, `transactions/${id}`); await fs.mkdir(root, { recursive: true }); await safeTeamPath(record.owner, `transactions/${id}/journal.json`); return root; }
async function save(root: string, journal: Journal): Promise<void> { const temporary = path.join(root, `${randomUUID()}.tmp`); try { await fs.writeFile(temporary, JSON.stringify(journal), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, path.join(root, 'journal.json')); } finally { await fs.rm(temporary, { force: true }); } }
async function read(root: string, record: TeamWorkspaceRecord, scopes: readonly string[]): Promise<Journal|null> {
  const file = await safeTeamPath(root, 'journal.json'); let metadata;
  try { metadata = await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!metadata.isFile() || metadata.size > 128 * 1024) throw new Error('Invalid integration journal');
  const journal = JSON.parse(await fs.readFile(file, 'utf8')) as Journal;
  if (![1, 2].includes(journal.version) || journal.source !== record.source || journal.workspace !== record.workspace || !['prepared', 'committed', 'recovered'].includes(journal.state) || !Array.isArray(journal.operations) || journal.operations.length > 20 || journal.operations.some(op => !op || typeof op.path !== 'string' || !authorized(op.path, scopes) || !validOperation(op) || op.beforeIdentity !== undefined && !identity(op.beforeIdentity) || op.installedIdentity !== undefined && !identity(op.installedIdentity))) throw new Error('Integration journal ownership or scope changed');
  return journal;
}
async function snapshot(root: string, file: string, signal?: AbortSignal) { const value = await safeReadFile(root, file, signal); return { ...value, hash: value.exists ? hash(value.bytes) : null }; }
function sameOperations(first: readonly TeamByteOperation[], second: readonly TeamByteOperation[]): boolean { return JSON.stringify(first.map(({ path, action, beforeHash, afterHash }) => ({ path, action, beforeHash, afterHash }))) === JSON.stringify(second); }
export async function recoverTeamIntegration(record: TeamWorkspaceRecord, id: string, scopes: readonly string[], guard: Guard, signal?: AbortSignal): Promise<{ conflicts: string[]; recovered: boolean }> {
  const root = await directory(record, id); const journal = await read(root, record, scopes);
  if (!journal) return { conflicts: [], recovered: true };
  if (journal.version !== 2) return { conflicts: journal.operations.map(op => op.path), recovered: false };
  if (journal.state !== 'prepared') return { conflicts: [], recovered: true };
  const conflicts: string[] = [];
  for (const [index, op] of [...journal.operations.entries()].reverse()) {
    try {
      const current = await snapshot(record.source, op.path, signal);
      if (current.hash === op.beforeHash && (current.identity ?? null) === op.beforeIdentity) continue;
      if (op.installedIdentity === undefined || current.hash !== op.afterHash || (current.identity ?? null) !== op.installedIdentity) { conflicts.push(op.path); continue; }
      const backup = op.beforeHash === null ? undefined : await snapshot(root, `${index}.before`, signal);
      if (backup && backup.hash !== op.beforeHash) throw new Error('Integration recovery backup changed');
      await guard(); signal?.throwIfAborted();
      const restored = await safeCommitFile(record.source, op.path, current.exists ? current.bytes : undefined, backup?.bytes, signal, op.beforeAttributes, current.identity);
      op.beforeIdentity = restored.identity ?? null; await save(root, journal);
    } catch (error) { if (error instanceof ResourceCleanupError) throw error; conflicts.push(op.path); }
  }
  if (!conflicts.length) { journal.state = 'recovered'; await save(root, journal); }
  return { conflicts, recovered: conflicts.length === 0 };
}

/** Host byte integration shares the native file protocol; no filesystem fallback. */
export async function integrateTeamBytes(record: TeamWorkspaceRecord, operations: readonly TeamByteOperation[], scopes: readonly string[], id: string, guard: Guard, signal?: AbortSignal): Promise<ApplyPatchResult> {
  if (!operations.length || operations.length > 20 || new Set(operations.map(op => op.path)).size !== operations.length || operations.some(op => !validOperation(op) || !authorized(op.path, scopes))) return { status: 'rejected', files: [], error: 'Unsafe byte integration scope' };
  const root = await directory(record, id); const prior = await read(root, record, scopes);
  if (prior?.state === 'committed') {
    if (prior.version !== 2 || !sameOperations(prior.operations, operations)) return { status: 'rejected', files: [], error: 'Integration identity or legacy evidence changed' };
    for (const op of prior.operations) { const current = await snapshot(record.source, op.path, signal); if (current.hash !== op.afterHash || op.installedIdentity === undefined || (current.identity ?? null) !== op.installedIdentity) return { status: 'rejected', files: [], error: 'Committed integration changed' }; }
    return { status: 'applied', files: operations.map(op => ({ path: op.path, action: op.action, status: 'applied' })) };
  }
  if (prior?.state === 'prepared') { const result = await recoverTeamIntegration(record, id, scopes, guard, signal); if (!result.recovered) return { status: 'failed', files: [], rolledBack: false, rollbackConflicts: result.conflicts, error: 'Prior integration requires conflict resolution' }; }
  const journal: Journal = { version: 2, source: record.source, workspace: record.workspace, state: 'prepared', operations: operations.map(op => ({ ...op })) };
  const files: ApplyPatchResult['files'] = []; let total = 0; let commitStarted = false;
  try {
    await guard(); signal?.throwIfAborted();
    for (const [index, op] of journal.operations.entries()) {
      const current = await snapshot(record.source, op.path, signal); const after = await snapshot(record.workspace, op.path, signal);
      if (current.hash !== op.beforeHash || after.hash !== op.afterHash) throw new Error('Integration artifact or destination changed');
      // Preflight both directions so rollback uses the same supported capacity.
      if (current.bytes.length > 32 * 1024 * 1024 || after.bytes.length > 32 * 1024 * 1024 || current.bytes.length + after.bytes.length > 64 * 1024 * 1024 - 128 * 1024) throw new SafeFileError('FILE_ACCESS_UNAVAILABLE', undefined, 'Byte integration exceeds the safe native mutation capacity');
      total += current.bytes.length + after.bytes.length; if (total > 2 * TEAM_TOTAL_LIMIT) throw new Error('Integration staging budget exceeded');
      op.beforeIdentity = current.identity ?? null; if (current.attributes !== undefined) op.beforeAttributes = current.attributes;
      for (const suffix of ['before', 'after']) await fs.rm(path.join(root, `${index}.${suffix}`), { force: true });
      if (current.exists) await fs.writeFile(path.join(root, `${index}.before`), current.bytes, { flag: 'wx', mode: 0o600 });
      if (after.exists) await fs.writeFile(path.join(root, `${index}.after`), after.bytes, { flag: 'wx', mode: 0o600 });
    }
    await save(root, journal);
    for (const [index, op] of journal.operations.entries()) {
      const before = op.beforeHash === null ? undefined : await snapshot(root, `${index}.before`, signal);
      const after = op.afterHash === null ? undefined : await snapshot(root, `${index}.after`, signal);
      if ((before?.hash ?? null) !== op.beforeHash || (after?.hash ?? null) !== op.afterHash) throw new Error('Staged integration bytes changed');
      await guard(); signal?.throwIfAborted(); commitStarted = true;
      const installed = await safeCommitFile(record.source, op.path, before?.bytes, after?.bytes, signal, undefined, op.beforeIdentity ?? undefined);
      op.installedIdentity = installed.identity ?? null; await save(root, journal);
      files.push({ path: op.path, action: op.action, status: 'applied', beforeSha256: op.beforeHash, afterSha256: op.afterHash, beforeFileIdentity: op.beforeIdentity!, afterFileIdentity: op.installedIdentity });
    }
    journal.state = 'committed'; await save(root, journal);
    return { status: 'applied', files, diffSummary: operations.map(op => `${op.action} ${op.path} (raw bytes)`).join('\n') };
  } catch (error) {
    if (error instanceof ResourceCleanupError) throw error;
    const recovered = commitStarted ? await recoverTeamIntegration(record, id, scopes, guard).catch(recoveryError => { if (recoveryError instanceof ResourceCleanupError) throw recoveryError; return { conflicts: operations.map(op => op.path), recovered: false }; }) : { conflicts: [], recovered: true };
    return { status: 'failed', files, rolledBack: recovered.recovered && !(error instanceof SafeFileError && (error.recoveryPath || commitStarted && error.code === 'FILE_ACCESS_UNAVAILABLE')), ...(recovered.conflicts.length ? { rollbackConflicts: recovered.conflicts } : {}), ...(error instanceof SafeFileError ? { errorCode: error.code, ...(error.recoveryPath ? { recoveryPath: error.recoveryPath } : {}) } : {}), error: error instanceof Error ? error.message : 'Byte integration failed' };
  }
}
