import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { realTaskSpecs } from './real-task-specs.mjs';

const sources = path.resolve(process.argv[2] ?? '.cache/benchmark-c-source');
const root = path.resolve(process.argv[3] ?? 'docs/benchmark/real-fixtures');
const refresh = process.argv.includes('--refresh');
const flag = refresh ? 'w' : 'wx';
await mkdir(root, { recursive: refresh });
const run = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const tasks = [];
for (const spec of realTaskSpecs) {
  const source = path.join(sources, spec.folder);
  const parent = run(source, ['rev-parse', `${spec.change}^`]).trim();
  const directory = path.join(root, spec.id); await mkdir(directory, { recursive: refresh });
  const full = spec.id.includes('esm') || spec.id.includes('node-tests') || spec.id.includes('help-option');
  const patch = run(source, ['diff', '--binary', parent, spec.change, '--', ...(full ? [] : spec.paths)]);
  if (!patch.startsWith('diff --git')) throw Error('Missing reference patch');
  await writeFile(path.join(directory, 'reference.patch'), patch, { flag });
  await writeFile(path.join(directory, 'source.json'), JSON.stringify({ repository: `https://github.com/${spec.repo}`, change: spec.change, parent, changeUrl: `https://github.com/${spec.repo}/commit/${spec.change}`, license: 'MIT', patchSha256: createHash('sha256').update(patch).digest('hex'), category: spec.category }, null, 2), { flag });
  const verification = mode => ({ command: 'node', args: ['${FIXTURE_ROOT}/verify.mjs', spec.id, '${WORKSPACE}', mode], timeoutMs: 120000 });
  tasks.push({ id: spec.id, prompt: spec.prompt, workspacePath: 'unused-before-preparation', tags: [spec.category, spec.folder], timeoutMs: spec.category === 'cross_module_refactor' ? 1800000 : 900000, maxRepairAttempts: 3, source: { sourceType: 'upstream_issue', repositoryUrl: `https://github.com/${spec.repo}`, commit: parent, issue: `https://github.com/${spec.repo}/commit/${spec.change}`, license: 'MIT' }, fixture: { startingState: 'upstream', setup: { command: 'node', args: ['${FIXTURE_ROOT}/setup.mjs', spec.id, '${WORKSPACE}'], timeoutMs: 180000 }, pristineVerification: verification('baseline'), referencePatch: `${spec.id}/reference.patch`, seedFailureContains: ['ERR_ASSERTION'] }, verification: { command: 'npm', args: ['test'], timeoutMs: 180000 }, acceptance: verification('acceptance'), regression: verification('regression'), allowedPaths: [...spec.paths, 'test', 'tests'] });
  console.log(JSON.stringify({ frozen: spec.id, parent }));
}
const catalog = path.join(root, 'catalog.json');
await writeFile(catalog, JSON.stringify({ schema: 1, tasks }, null, 2), { flag });
// Evaluator setup scripts and lock are copied separately after review; no provider calls.
await access(path.join(sources, 'chalk'));
const license = run(path.join(sources, 'chalk'), ['show', `${realTaskSpecs[0].change}:license`]);
await writeFile(path.join(root, 'LICENSE.chalk.txt'), license, { flag });
for (const [repo, file] of [['commander', 'LICENSE'], ['dayjs', 'LICENSE']]) await writeFile(path.join(root, `LICENSE.${repo}.txt`), run(path.join(sources, repo), ['show', `HEAD:${file}`]), { flag });
const lock = await readFile('pnpm-lock.yaml', 'utf8');
await writeFile(path.join(root, 'evaluator-lock.yaml'), lock, { flag });
