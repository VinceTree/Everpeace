import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeReadDirectory } from './safe-files.js';

export function globPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^$()|\\]/gu, '\\$&').replace(/\*\*/gu, '__EP_DOUBLE_STAR__').replace(/\*/gu, '[^/]*').replace(/\?/gu, '[^/]').replace(/__EP_DOUBLE_STAR__\//gu, '(?:.*/)?').replace(/__EP_DOUBLE_STAR__/gu, '.*').replace(/\{([^}]+)\}/gu, (_all, choices: string) => `(?:${choices.split(',').join('|')})`);
  return new RegExp(`^${escaped}$`, 'u');
}
interface IgnoreRule { prefix: string; expression: RegExp; basename: boolean; negate: boolean; directory: boolean }
export async function enumerateSafeFiles(workspace: string, requested: string, signal?: AbortSignal, options: { timeoutMs?: number; maxPaths?: number; maxBytes?: number; excluded?: ReadonlySet<string> } = {}): Promise<{ paths: string[]; incomplete: boolean; reasons: string[] }> {
  const paths: string[] = []; const reasons = new Set<string>();
  const timeout = options.timeoutMs ?? 5000; const deadline = Date.now() + timeout;
  const maximum = options.maxPaths ?? 10_000; const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const excluded = options.excluded ?? new Set(['.git', '.codex', '.agents', '.everpeace', 'node_modules']);
  let bytes = 0;
  const ignored = (name: string, directory: boolean, rules: IgnoreRule[]) => {
    let result = false;
    for (const rule of rules) {
      if (rule.directory && !directory || !name.startsWith(rule.prefix)) continue;
      const value = name.slice(rule.prefix.length);
      if (rule.expression.test(value) || rule.basename && rule.expression.test(path.posix.basename(value))) result = !rule.negate;
    }
    return result;
  };
  const visit = async (relative: string, inherited: IgnoreRule[]): Promise<void> => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) { reasons.add('enumeration_timeout'); return; }
    const rules = [...inherited]; const prefix = relative === '.' ? '' : relative.split(path.sep).join('/') + '/';
    const { entries, ignores } = await safeReadDirectory(workspace, relative, signal);
    for (const value of ignores) {
      if (value === '\x01') { reasons.add('ignore_byte_limit'); continue; }
      for (let pattern of value.split(/\r?\n/u)) {
        if (!pattern || pattern.startsWith('#')) continue;
        const negate = pattern.startsWith('!'); if (negate) pattern = pattern.slice(1);
        const directory = pattern.endsWith('/'); if (directory) pattern = pattern.slice(0, -1);
        const anchored = pattern.startsWith('/'); if (anchored) pattern = pattern.slice(1);
        try { rules.push({ prefix, expression: globPattern(pattern), basename: !anchored && !pattern.includes('/'), negate, directory }); }
        catch { reasons.add('ignore_pattern_unsupported'); }
      }
    }
    if (entries.length === 10_000) reasons.add('directory_entry_limit');
    for (const entry of entries) {
      if (excluded.has(entry.name) || /\.everpeace-(?:recovery|stage)-/u.test(entry.name) || entry.type === 'symlink') continue;
      const next = path.join(relative === '.' ? '' : relative, entry.name); const normal = next.split(path.sep).join('/');
      if (ignored(normal, entry.type === 'directory', rules)) continue;
      if (entry.type === 'directory') await visit(next, rules);
      else { paths.push(normal); bytes += Buffer.byteLength(normal) + 1; }
      if (paths.length >= maximum) { reasons.add('path_limit'); break; }
      if (bytes > maxBytes) { reasons.add('enumeration_byte_limit'); break; }
      if (Date.now() >= deadline) { reasons.add('enumeration_timeout'); break; }
    }
  };
  // Selection is metadata only; every traversal and content read is handle-relative.
  if ((await fs.lstat(path.resolve(workspace, requested))).isFile()) paths.push(requested.split(path.sep).join('/'));
  else if (timeout <= 0) reasons.add('enumeration_timeout');
  else await visit(requested, []);
  return { paths, incomplete: reasons.size > 0, reasons: [...reasons] };
}
