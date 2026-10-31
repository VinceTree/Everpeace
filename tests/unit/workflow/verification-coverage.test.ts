import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { discoverVerificationCoverage } from '../../../src/workflow/verification-coverage.js';
import { CodingWorkflowRuntime } from '../../../src/workflow/runtime.js';
import { VerificationBasisGuard } from '../../../src/workflow/verification-basis.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'everpeace-nested-checks-'));
  await fs.mkdir(path.join(root, 'packages/one'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'], scripts: { test: 'echo root' } }));
  await fs.writeFile(path.join(root, 'packages/one/package.json'), JSON.stringify({ scripts: { typecheck: 'echo type', test: 'echo test' } }));
  await fs.writeFile(path.join(root, 'packages/one/a.ts'), 'before');
  execFileSync('git', ['init', '--quiet', root]); execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  return root;
}
test('nested discovery distinguishes unaffected packages, shared changes and unknown declarations', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual((await discoverVerificationCoverage(root, ['README.md'])).uncovered, []);
  assert.deepEqual((await discoverVerificationCoverage(root, ['packages/one/a.ts'])).uncovered, ['packages/one']);
  assert.deepEqual((await discoverVerificationCoverage(root, ['pnpm-lock.yaml'])).uncovered, ['packages/one']);
  await fs.writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - missing/*\n');
  assert.equal((await discoverVerificationCoverage(root)).incomplete, true);
});
test('nested manifests remain visible when the root has no Node manifest', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.unlink(path.join(root, 'package.json'));
  const coverage = await discoverVerificationCoverage(root, ['packages/one/a.ts']);
  assert.deepEqual(coverage.packages, ['packages/one']); assert.deepEqual(coverage.uncovered, ['packages/one']); assert.equal(coverage.incomplete, false);
});
test('root success retains nested debt until explicit package checks bind the same revision', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const root = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workflow = new CodingWorkflowRuntime({ workspacePath: root, confirmVerificationBasis: async () => true });
  await workflow.beginTurn(); await fs.writeFile(path.join(root, 'packages/one/a.ts'), 'after'); await workflow.observeShellExecution();
  const run = async () => ({ stdout: '', stderr: '', exitCode: 0, signal: null });
  assert.equal((await workflow.finishTurn(run)).state.result, 'unverified');
  const commands: string[] = [];
  const packageResult = await workflow.runPackageVerification('packages/one', async (command, cwd) => { assert.equal(cwd, path.join(root, 'packages/one')); commands.push(command); return run(); });
  assert.equal(packageResult.status, 'passed'); assert.equal(commands.length, 2);
  assert.equal(workflow.state.pending_verification, true);
  assert.equal((await workflow.finishTurn(run)).state.result, 'verified');
  await fs.writeFile(path.join(root, 'packages/one/a.ts'), 'later');
  assert.equal((await workflow.finishTurn(run)).state.result, 'unverified');
});
test('nested script changes and approval races are guarded before execution', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'packages/one/package.json'); const write = (test: string) => fs.writeFile(file, JSON.stringify({ scripts: { test } }));
  const denied = new VerificationBasisGuard(root); await denied.begin(); await write('weakened'); assert.equal(await denied.authorize(), false);
  const race = new VerificationBasisGuard(root, async () => { await write('changed again'); return true; }); await race.begin(); await write('next'); assert.equal(await race.authorize(), false);
});
