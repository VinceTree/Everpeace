import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parse } from 'yaml';
import { safeReadFile } from '../tools/safe-files.js';
import { enumerateSafeFiles, globPattern } from '../tools/secure-enumeration.js';
import { ResourceCleanupError } from '../util/resource-cleanup-error.js';

export interface VerificationCoverage { packages: string[]; incomplete: boolean; reasons: string[]; uncovered: string[] }
export async function discoverVerificationCoverage(workspace: string, changed: readonly string[] = [], evidence: ReadonlyMap<string, string> = new Map(), revision?: string, signal?: AbortSignal): Promise<VerificationCoverage> {
  signal?.throwIfAborted();
  try { await fs.lstat(workspace); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { packages: [], incomplete: false, reasons: [], uncovered: [] }; throw error; }
  const root = await safeReadFile(workspace, 'package.json', signal);
  const reasons = new Set<string>(); let patterns: string[] = [];
  try {
    if (root.bytes.length > 256 * 1024) throw new Error('limit');
    const value = (root.exists ? JSON.parse(root.bytes.toString()) : {}) as { workspaces?: unknown };
    const declared = Array.isArray(value.workspaces) ? value.workspaces : (value.workspaces as { packages?: unknown } | undefined)?.packages;
    if (declared !== undefined && (!Array.isArray(declared) || declared.some(pattern => typeof pattern !== 'string'))) reasons.add('workspace_declaration_invalid');
    else patterns = declared as string[] ?? [];
    const pnpm = await safeReadFile(workspace, 'pnpm-workspace.yaml', signal);
    if (pnpm.exists) {
      if (pnpm.bytes.length > 256 * 1024) throw new Error('limit');
      const value = parse(pnpm.bytes.toString()) as { packages?: unknown };
      if (!Array.isArray(value.packages) || value.packages.some(pattern => typeof pattern !== 'string')) reasons.add('workspace_declaration_invalid');
      else patterns.push(...value.packages as string[]);
    }
  } catch (error) { if (error instanceof ResourceCleanupError || signal?.aborted) throw error; reasons.add('workspace_declaration_unreadable'); }
  const files = await enumerateSafeFiles(workspace, '.', signal, { timeoutMs: 10000 });
  files.reasons.forEach(reason => reasons.add(reason));
  const candidates = files.paths.filter(file => file !== 'package.json' && path.posix.basename(file) === 'package.json');
  if (candidates.length > 32) reasons.add('manifest_count_limit');
  const packages: string[] = []; let total = 0;
  for (const file of candidates.slice(0, 32)) {
    try {
      const value = await safeReadFile(workspace, file, signal); total += value.bytes.length;
      if (!value.exists || value.bytes.length > 256 * 1024 || total > 1024 * 1024) { reasons.add('manifest_byte_limit'); continue; }
      const parsed = JSON.parse(value.bytes.toString()); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
      packages.push(path.posix.dirname(file));
    } catch (error) { if (error instanceof ResourceCleanupError) throw error; reasons.add('nested_manifest_unreadable'); }
  }
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    try { if (!packages.some(dir => globPattern(pattern.replace(/\/$/u, '')).test(dir))) reasons.add('declared_package_not_discovered'); }
    catch { reasons.add('workspace_pattern_unsupported'); }
  }
  const shared = changed.some(file => /^(?:package\.json|pnpm-workspace\.yaml|(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?))$/u.test(file));
  const affected = packages.filter(dir => shared || changed.some(file => file === dir || file.startsWith(dir + '/')));
  const uncovered = affected.filter(dir => !revision || evidence.get(dir) !== revision);
  return { packages: packages.sort(), incomplete: reasons.size > 0, reasons: [...reasons], uncovered };
}
