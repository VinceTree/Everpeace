import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Offline fixtures only. No registry, credentials, models or existing Session directories.
const sourceCheckout = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const checkout = path.resolve(process.env.EVERPEACE_PERF_CHECKOUT ?? sourceCheckout);
const [mode, rootArgument, label = 'sample'] = process.argv.slice(2);
const root = path.resolve(rootArgument ?? '.cache/local-performance');
const marker = path.join(root, 'fixture.json');
const model = { id: 'fixture', model_name: 'fixture', base_url: 'https://example.invalid/v1' };
const at = '2026-01-01T00:00:00.000Z';
const event = (type, body) => JSON.stringify({ version: 1, type, at, ...body }) + '\n';
const header = (id, workspace) => event('session_created', { session_id: id, title: `Fixture ${id}`, title_pending: false, workspace_path: workspace, model, usage_tracking: true });
const workspace = path.join(root, 'project');
const moduleAt = (name) => pathToFileURL(path.join(checkout, 'dist', name)).href;

async function treeDigest(directories) {
  const hash = createHash('sha256');
  for (const directory of directories) {
    const visit = async (relative) => {
      const target = path.join(directory, relative);
      const entries = await fs.readdir(target, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
      for (const entry of entries) {
        const next = path.join(relative, entry.name);
        if (entry.isDirectory()) await visit(next);
        else if (entry.isFile()) hash.update(next.split(path.sep).join('/')).update(await fs.readFile(path.join(directory, next)));
        else throw new Error('Benchmark identity cannot contain links or special files');
      }
    };
    await visit('');
  }
  return hash.digest('hex');
}

async function identity(directory) {
  return { source: await treeDigest([path.join(directory, 'src')]), build: await treeDigest([path.join(directory, 'dist')]), native: await treeDigest(['files', 'process'].map(component => path.join(directory, 'native', component, 'bin'))) };
}

async function prepare() {
  // Exclusive creation prevents overwriting or cleaning any pre-existing user directory.
  await fs.mkdir(root);
  await fs.mkdir(workspace);
  const long = path.join(root, 'long');
  const history = path.join(root, 'history');
  await fs.mkdir(long); await fs.mkdir(history);
  const write = async (file, text) => { await fs.writeFile(file, text); };
  const text = 'Synthetic 中🙂 conversation text. '.repeat(32);
  let log = header('long-session', workspace);
  for (let index = 0; index < 20_000; index++) {
    for (const role of ['user', 'assistant']) {
      const content = `${index}: ${text}`;
      log += event('timeline_entry', { entry: { kind: role, text: content } });
      log += event('context_append', { items: [{ role, content }] });
    }
  }
  log += event('context_compacted', { items: [{ role: 'user', content: 'final compacted context' }], automatic: true, usage: null });
  await write(path.join(long, 'long-session.jsonl'), log);
  for (let index = 0; index < 100; index++) {
    const id = `history-${String(index).padStart(3, '0')}`;
    let contents = header(id, workspace);
    for (let turn = 0; turn < 80; turn++) {
      for (const role of ['user', 'assistant']) {
        const content = `${turn} ${role === 'user' && turn === 40 ? 'needle' : 'ordinary'} ${text.slice(0, 400)}`;
        contents += event('timeline_entry', { entry: { kind: role, text: content } });
        contents += event('context_append', { items: [{ role, content: 'context-only-hidden-token' }] });
      }
    }
    await write(path.join(history, `${id}.jsonl`), contents);
  }
  await write(path.join(workspace, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
  await write(path.join(workspace, '.gitignore'), 'ignored/\n');
  await fs.mkdir(path.join(workspace, 'ignored'));
  await write(path.join(workspace, 'ignored', 'hidden.ts'), 'hidden');
  for (let index = 0; index < 20; index++) {
    const directory = path.join(workspace, 'packages', `pkg-${String(index).padStart(2, '0')}`);
    await fs.mkdir(path.join(directory, 'src'), { recursive: true });
    await fs.mkdir(path.join(directory, 'tests'));
    await write(path.join(directory, 'README.md'), 'Synthetic fixture');
    for (let file = 0; file < 20; file++) {
      await write(path.join(directory, file < 16 ? 'src' : 'tests', `file-${file}.ts`), "import value from './other.js';\nexport const fixture = 1;\n");
    }
  }
  await fs.writeFile(marker, JSON.stringify({ schema: 1, digest: await treeDigest([long, history, workspace]), longRecords: 80_002, longBytes: Buffer.byteLength(log), sessions: 100, projectFiles: 422 }, null, 2));
}

async function worker(scenario) {
  const { SessionStore } = await import(moduleAt('storage/session-store.js'));
  const { PerformanceTrace } = await import(moduleAt('performance/trace.js'));
  const { runProjectMap } = await import(moduleAt('tools/project-map.js'));
  const { nativeProcessBackend, processOwnerDiagnostics } = await import(moduleAt('tools/owned-process.js'));
  let nativeLaunches = 0;
  const launch = nativeProcessBackend.launch;
  nativeProcessBackend.launch = (...args) => { nativeLaunches++; return launch(...args); };
  const trace = new PerformanceTrace();
  const store = new SessionStore({ directory: path.join(root, scenario === 'restore' ? 'long' : 'history'), trace });
  if (scenario === 'search-warm') await store.search({ query: 'needle', workspacePath: workspace });
  const cpu = process.cpuUsage();
  const start = performance.now();
  let correctness;
  if (scenario === 'restore') {
    const loaded = await store.load('long-session');
    assert.equal(loaded.timeline.length, 40_000);
    assert.deepEqual(loaded.context, [{ role: 'user', content: 'final compacted context' }]);
    correctness = { timeline: loaded.timeline.length, context: loaded.context.length };
  } else if (scenario.startsWith('search-')) {
    const found = await store.search({ query: 'needle', workspacePath: workspace });
    assert.equal(found.total, 100); assert.equal(found.skipped, 0);
    assert.equal(found.matches.length, 50);
    correctness = { total: found.total, returned: found.matches.length, skipped: found.skipped };
  } else {
    const map = await runProjectMap({}, workspace);
    assert.equal(map.observedFiles, 422);
    assert.ok(!map.reasons.includes('enumeration_timeout'));
    correctness = { files: map.observedFiles, reasons: map.reasons };
  }
  const durationMs = performance.now() - start;
  const owners = processOwnerDiagnostics();
  assert.ok(owners.every(owner => owner.status === 'confirmed_exited'));
  return { durationMs, cpuMicros: process.cpuUsage(cpu), peakRssBytes: process.resourceUsage().maxRSS * 1024, correctness, trace: trace.snapshot(), native: { launches: nativeLaunches, retainedReceipts: owners.length, retainedDurationMs: owners.reduce((sum, owner) => sum + owner.durationMs, 0), confirmed: owners.every(owner => owner.status === 'confirmed_exited') } };
}

if (mode === 'prepare') {
  await prepare();
  console.log(`Prepared ${marker}`);
} else if (mode?.startsWith('worker:')) {
  console.log(JSON.stringify(await worker(mode.slice(7))));
} else if (mode === 'measure' || mode === 'compare') {
  const fixture = JSON.parse(await fs.readFile(marker, 'utf8'));
  const fixtureDigest = () => treeDigest(['long', 'history', 'project'].map(name => path.join(root, name)));
  assert.equal(await fixtureDigest(), fixture.digest, 'Fixture changed');
  const arms = mode === 'compare' ? { baseline: path.resolve(process.argv[5]), candidate: checkout } : { [label]: checkout };
  const identities = {};
  for (const [arm, directory] of Object.entries(arms)) identities[arm] = await identity(directory);
  if (mode === 'compare') assert.equal(identities.baseline.native, identities.candidate.native, 'Native components must match');
  const report = { schema: 1, label, fixture, identities, runnerDigest: createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'), environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpu: os.cpus()[0]?.model }, samples: {}, summary: {} };
  const script = fileURLToPath(import.meta.url);
  for (const scenario of ['cli-help', 'restore', 'search-cold', 'search-warm', 'project-map']) {
    const byArm = Object.fromEntries(Object.keys(arms).map(arm => [arm, []]));
    for (let index = 0; index < 9; index++) {
      const order = Object.entries(arms);
      if (index % 2) order.reverse();
      for (const [arm, directory] of order) {
      const start = performance.now();
      const cli = scenario === 'cli-help';
      const child = spawnSync(process.execPath, cli ? [path.join(directory, 'dist/cli/index.js'), '--lang', 'en', '--help'] : [script, `worker:${scenario}`, root], { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024, env: { ...process.env, EVERPEACE_LANG: 'en', EVERPEACE_PERF_CHECKOUT: directory } });
      if (child.error) throw child.error;
      assert.equal(child.status, 0, child.stderr);
      const elapsedMs = performance.now() - start;
      if (cli) { assert.match(child.stdout, /Usage:/u); byArm[arm].push({ durationMs: elapsedMs }); }
      else byArm[arm].push(JSON.parse(child.stdout));
      }
    }
    report.samples[scenario] = byArm;
    report.summary[scenario] = {};
    for (const [arm, samples] of Object.entries(byArm)) {
      const ordered = samples.map(sample => sample.durationMs).sort((a, b) => a - b);
      report.summary[scenario][arm] = { medianMs: ordered[4], p95Ms: ordered.at(-1), minMs: ordered[0], maxMs: ordered.at(-1) };
    }
    if (mode === 'compare' && scenario !== 'cli-help') assert.deepEqual(byArm.baseline.map(sample => sample.correctness), byArm.candidate.map(sample => sample.correctness));
    console.log(JSON.stringify({ scenario, ...report.summary[scenario] }));
  }
  assert.equal(await fixtureDigest(), fixture.digest, 'Fixture changed during measurement');
  for (const [arm, directory] of Object.entries(arms)) assert.deepEqual(await identity(directory), identities[arm], 'Measured build changed');
  const output = path.join(root, `${label}.json`);
  await fs.writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx' });
} else throw new Error('Usage: node scripts/benchmark/local-performance.mjs prepare|measure|compare <fixture-root> [label] [baseline-checkout]');
