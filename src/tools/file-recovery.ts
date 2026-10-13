import path from 'node:path';
import { safeReadFile, safeCommitFile, SafeFileError } from './safe-files.js';

/** Explicit user recovery. Journals and bytes never enter Agent or Session context. */
export async function recoverFile(workspace: string, backup: string): Promise<void> {
  if (!/\.everpeace-recovery-[a-f0-9]{32}\.bak$/u.test(backup)) throw new SafeFileError('POLICY_DENIED');
  const old = await safeReadFile(workspace, backup);
  const journal = await safeReadFile(workspace, `${backup}.journal`);
  if (!old.exists || !journal.exists || journal.bytes.subarray(0, 4).toString() !== 'EPJ2') throw new SafeFileError('POLICY_DENIED');
  let offset = 4;
  const read = () => {
    if (offset + 4 > journal.bytes.length) throw new SafeFileError('POLICY_DENIED');
    const length = journal.bytes.readUInt32LE(offset); offset += 4;
    if (length > 64 * 1024 * 1024 || offset + length > journal.bytes.length) throw new SafeFileError('POLICY_DENIED');
    const value = journal.bytes.subarray(offset, offset + length); offset += length; return value;
  };
  const relative = read().toString('utf8'); const original = read(); const after = read(); const identity = read().toString('utf8'); const installedIdentity = read().toString('utf8');
  if (offset !== journal.bytes.length || !original.equals(old.bytes) || identity !== old.identity || path.isAbsolute(relative) || path.dirname(relative) !== path.dirname(backup)) throw new SafeFileError('POLICY_DENIED');
  const current = await safeReadFile(workspace, relative);
  if (current.exists && (!current.bytes.equals(after) || current.identity !== installedIdentity)) throw new SafeFileError('FILE_CONFLICT');
  await safeCommitFile(workspace, relative, current.exists ? current.bytes : undefined, original, undefined, old.attributes, current.identity);
  // Remove only still-matching recovery artifacts. Concurrent edits remain untouched.
  await safeCommitFile(workspace, backup, old.bytes, undefined, undefined, undefined, old.identity);
  await safeCommitFile(workspace, `${backup}.journal`, journal.bytes, undefined, undefined, undefined, journal.identity);
}
