import { uiText } from "../localization/messages.js";
import { safeReadFile } from "../tools/safe-files.js";
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safeApprovalText } from '../permissions/sensitive-access.js';
import { discoverVerificationCoverage } from './verification-coverage.js';

export interface VerificationBasis { raw: string; execution: string }
async function ownBasis(workspace: string, signal?: AbortSignal): Promise<VerificationBasis> {
  try { await fs.lstat(path.join(workspace, 'package.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { raw: 'missing', execution: 'missing' }; throw error; }
  let bytes: Buffer;
  try { const value = await safeReadFile(workspace, 'package.json', signal); if (!value.exists) return { raw: 'missing', execution: 'missing' }; bytes = value.bytes; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { raw: 'missing', execution: 'missing' }; throw error; }
  if (bytes.length > 256 * 1024) throw new Error('Verification manifest exceeds limit');
  const manifest = JSON.parse(bytes.toString('utf8')) as { scripts?: Record<string, unknown>; packageManager?: unknown; workspaces?: unknown };
  const scripts: Record<string, unknown> = {};
  for (const name of ['typecheck', 'lint', 'test', 'build']) for (const script of [name, `pre${name}`, `post${name}`]) if (manifest.scripts?.[script] !== undefined) scripts[script] = manifest.scripts[script];
  const locks: string[] = [];
  for (const name of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']) { try { if ((await fs.stat(path.join(workspace, name))).isFile()) locks.push(name); } catch { /* absent selection inputs */ } }
  return { raw: createHash('sha256').update(bytes).digest('hex'), execution: JSON.stringify({ scripts, packageManager: manifest.packageManager, locks, workspaces: manifest.workspaces }) };
}
export async function captureVerificationBasis(workspace: string, packages: readonly string[] = [], signal?: AbortSignal): Promise<VerificationBasis> {
  const root = await ownBasis(workspace, signal);
  const nested = await Promise.all(packages.map(async relative => ({ relative, ...await ownBasis(path.join(workspace, relative), signal) })));
  let config = 'missing';
  try {
    await fs.lstat(path.join(workspace, 'pnpm-workspace.yaml'));
    const yaml = await safeReadFile(workspace, 'pnpm-workspace.yaml', signal);
    if (yaml.exists) config = createHash('sha256').update(yaml.bytes).digest('hex');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!nested.length && config === 'missing') return root;
  return { raw: createHash('sha256').update(JSON.stringify({ root: root.raw, nested: nested.map(({ relative, raw }) => ({ relative, raw })), config })).digest('hex'), execution: JSON.stringify({ root: root.execution, nested: nested.map(({ relative, execution }) => ({ relative, execution })), config }) };
}

export class VerificationBasisGuard {
  #basis: VerificationBasis | undefined;
  #packages: string[] = [];
  notice: ((summary: string) => void) | undefined;
  constructor(readonly workspace: string, public confirm?: (summary: string, signal?: AbortSignal) => Promise<boolean>, public revision: () => string = () => '') {}
  async begin(signal?: AbortSignal): Promise<void> { this.#packages = (await discoverVerificationCoverage(this.workspace, [], undefined, undefined, signal)).packages; this.#basis = await captureVerificationBasis(this.workspace, this.#packages, signal); }
  includePackage(relative: string): void { if (!this.#packages.includes(relative)) { this.#packages.push(relative); this.#basis = undefined; } }
  resume(): void { this.#basis = undefined; }
  async authorize(signal?: AbortSignal): Promise<boolean> {
    const current = await captureVerificationBasis(this.workspace, this.#packages);
    if (this.#basis?.execution === current.execution) { if (this.#basis.raw !== current.raw) this.notice?.(uiText("security.metadataChanged")); this.#basis = current; return true; }
    const revision = this.revision();
    const prompt = safeApprovalText(uiText("security.verificationPrompt", { p0: this.#basis?.execution ?? uiText("security.noBaseline"), p1: current.execution }));
    const allowed = await this.confirm?.(prompt, signal) ?? false;
    signal?.throwIfAborted();
    const fresh = await captureVerificationBasis(this.workspace, this.#packages);
    if (!allowed || this.revision() !== revision || current.raw !== fresh.raw || current.execution !== fresh.execution) return false;
    this.#basis = fresh;
    return true;
  }
}
