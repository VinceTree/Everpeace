import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { realTaskSpecs } from './real-task-specs.mjs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const root = path.resolve('docs/benchmark/real-fixtures');
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const tar = createRequire(npm)('tar');
if (createRequire(npm)('tar/package.json').version !== '6.2.1') throw Error('Review the archive parser revision');
for (const spec of realTaskSpecs) {
  const provenance = JSON.parse(await readFile(path.join(root, spec.id, 'source.json'), 'utf8'));
  const workspace = path.resolve('.cache/benchmark-c-locks-v5', spec.id);
  await mkdir(path.dirname(workspace), { recursive: true });
  execFileSync('git', ['clone', '--quiet', '--no-checkout', '--no-hardlinks', '-c', 'core.autocrlf=false', path.resolve('.cache/benchmark-c-source', spec.folder), workspace], { windowsHide: true });
  const response = await fetch(`https://codeload.github.com/${spec.repo}/tar.gz/${provenance.parent}`, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw Error('Archive download failed: ' + response.status);
  const archive = path.join(workspace, 'source.tar.gz');
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(archive, bytes, { flag: 'wx' });
  const links = [];
  await tar.t({ file: archive, onentry(entry) { if (entry.path.startsWith('/') || entry.path.includes('..') || entry.path.includes('\\')) throw Error('Unsafe archive path'); if (entry.type === 'SymbolicLink') links.push({ path: entry.path.split('/').slice(1).join('/'), target: entry.linkpath }); } });
  await tar.x({ file: archive, cwd: workspace, strip: 1, filter(_name, entry) { return ['File', 'Directory'].includes(entry.type); } });
  for (const link of links) await writeFile(path.join(workspace, link.path), link.target, { flag: 'wx' });
  const tracked = execFileSync('git', ['ls-tree', '-rz', provenance.parent], { cwd: workspace, encoding: 'utf8' }).split('\0').filter(Boolean).map(row => row.split('\t'));
  if (tracked.some(([meta, name]) => !/^(100644|100755|120000) blob /.test(meta) || name.includes('\n'))) throw Error('Unsupported upstream entry');
  const hashes = execFileSync('git', ['hash-object', '-w', '--stdin-paths'], { cwd: workspace, input: tracked.map(([, name]) => name).join('\n') + '\n', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n');
  for (const [index, [meta, name]] of tracked.entries()) if (hashes[index] !== meta.split(' ')[2]) throw Error('Archive blob identity mismatch: ' + name);
  console.log('Verified archive ' + createHash('sha256').update(bytes).digest('hex'));
  execFileSync('git', ['read-tree', provenance.parent], { cwd: workspace, windowsHide: true });
  execFileSync('git', ['update-ref', '--no-deref', 'HEAD', provenance.parent], { cwd: workspace, windowsHide: true });
  execFileSync('git', ['config', 'core.symlinks', 'false'], { cwd: workspace, windowsHide: true });
  try { await access(path.join(workspace, 'package-lock.json')); console.log('Upstream lock: ' + spec.id); continue; }
  catch { /* Freeze historical upstreams without npm locks before proof. */ }
  try { await access(path.join(root, spec.id, 'package-lock.json')); console.log('Existing frozen lock: ' + spec.id); continue; }
  catch { /* No reviewed lock exists for this source yet. */ }
  execFileSync(process.execPath, [npm, 'install', '--package-lock-only', '--package-lock=true', '--ignore-scripts', '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund'], { cwd: workspace, windowsHide: true, stdio: 'inherit', timeout: 170000 });
  await writeFile(path.join(root, spec.id, 'package-lock.json'), await readFile(path.join(workspace, 'package-lock.json')), { flag: 'wx' });
  console.log('Frozen lock: ' + spec.id);
}
