import { spawnOwned as spawn } from '../tools/owned-process.js';
import { observeProcessCompletion } from '../tools/process-completion.js';

/** Incomplete, binary and untracked diffs stay unknown. */
export async function captureChangedLines(workspacePath: string, paths: readonly string[], signal?: AbortSignal): Promise<Record<string, number[]>> {
  const changed: Record<string, number[]> = Object.create(null);
  if (!paths.length || paths.length > 10000 || paths.some(p => /[\r\n\0]/u.test(p))) return changed;
  const child = spawn('git', ['-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-textconv', '--relative', '--unified=0', 'HEAD', '--', ...paths], {cwd: workspacePath, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore','pipe','pipe']});
  const owned = observeProcessCompletion(child, { ...(signal ? {signal} : {}), timeoutMs: 30000 });
  let output = ''; let overflow = false;
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (value: string) => { if (Buffer.byteLength(output) + Buffer.byteLength(value) > 2 * 1024 * 1024) { overflow = true; owned.stop(); } else output += value; });
  child.stderr!.resume();
  const result = await owned.completion;
  if (result.cleanupError) throw result.cleanupError;
  signal?.throwIfAborted();
  if (overflow || result.exitCode !== 0 || result.error || result.timedOut) return changed;
  let file: string | undefined;
  const allowed = new Set(paths.map(p => p.replaceAll('\\','/')));
  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git ')) file = undefined;
    if (line.startsWith('+++ b/')) { const candidate = line.slice(6).replace(/\r$/u, ''); if (allowed.has(candidate)) { file = candidate; changed[file] = []; } }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (file && hunk) {
      const start = Number(hunk[1]); const length = Number(hunk[2] ?? 1);
      if (length > 100000 || changed[file]!.length + length > 100000) { delete changed[file]; file = undefined; continue; }
      for (let i=0;i<length;i++) changed[file]!.push(start+i);
    }
  }
  return changed;
}
