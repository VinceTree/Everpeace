import { uiText } from "../localization/messages.js";
import { safeReadFile } from "../tools/safe-files.js";
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safeApprovalText } from '../permissions/sensitive-access.js';

export interface VerificationBasis { raw: string; execution: string }
export async function captureVerificationBasis(workspace: string): Promise<VerificationBasis> {
  try { await fs.lstat(path.join(workspace, 'package.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { raw: 'missing', execution: 'missing' }; throw error; }
  let bytes: Buffer;
  try { const value = await safeReadFile(workspace, 'package.json'); if (!value.exists) return { raw: 'missing', execution: 'missing' }; bytes = value.bytes; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { raw: 'missing', execution: 'missing' }; throw error; }
  if (bytes.length > 256 * 1024) throw new Error('Verification manifest exceeds limit');
  const manifest = JSON.parse(bytes.toString('utf8')) as { scripts?: Record<string, unknown>; packageManager?: unknown };
  const scripts: Record<string, unknown> = {};
  for (const name of ['typecheck', 'lint', 'test', 'build']) for (const script of [name, `pre${name}`, `post${name}`]) if (manifest.scripts?.[script] !== undefined) scripts[script] = manifest.scripts[script];
  const locks: string[] = [];
  for (const name of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']) { try { if ((await fs.stat(path.join(workspace, name))).isFile()) locks.push(name); } catch { /* absent selection inputs */ } }
  return { raw: createHash('sha256').update(bytes).digest('hex'), execution: JSON.stringify({ scripts, packageManager: manifest.packageManager, locks }) };
}

export class VerificationBasisGuard {
  #basis: VerificationBasis | undefined;
  notice: ((summary: string) => void) | undefined;
  constructor(readonly workspace: string, public confirm?: (summary: string, signal?: AbortSignal) => Promise<boolean>, public revision: () => string = () => '') {}
  async begin(): Promise<void> { this.#basis = await captureVerificationBasis(this.workspace); }
  resume(): void { this.#basis = undefined; }
  async authorize(signal?: AbortSignal): Promise<boolean> {
    const current = await captureVerificationBasis(this.workspace);
    if (this.#basis?.execution === current.execution) { if (this.#basis.raw !== current.raw) this.notice?.(uiText("security.metadataChanged")); this.#basis = current; return true; }
    const revision = this.revision();
    const prompt = safeApprovalText(uiText("security.verificationPrompt", { p0: this.#basis?.execution ?? uiText("security.noBaseline"), p1: current.execution }));
    const allowed = await this.confirm?.(prompt, signal) ?? false;
    signal?.throwIfAborted();
    const fresh = await captureVerificationBasis(this.workspace);
    if (!allowed || this.revision() !== revision || current.raw !== fresh.raw || current.execution !== fresh.execution) return false;
    this.#basis = fresh;
    return true;
  }
}
