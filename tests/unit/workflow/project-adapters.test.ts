import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ADAPTERS, detectProjectAdapter, discoverProjectChecks } from '../../../src/projects/adapters.js';
test('read-only project adapters preserve mixed and malformed-manifest priorities', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ep-adapters-'));
    try {
        assert.equal(await detectProjectAdapter(workspace), undefined);
        await fs.writeFile(path.join(workspace, 'Cargo.toml'), '[package]\n');
        await fs.writeFile(path.join(workspace, 'go.mod'), 'module fixture\n');
        assert.equal((await detectProjectAdapter(workspace))?.kind, 'rust');
        await fs.writeFile(path.join(workspace, 'pyproject.toml'), '[project]\n');
        await fs.writeFile(path.join(workspace, 'package.json'), '{invalid');
        assert.equal((await detectProjectAdapter(workspace))?.kind, 'python');
        await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { typecheck: 'fixture', lint: 'fixture', test: 'fixture', build: 'fixture' } }));
        assert.equal((await detectProjectAdapter(workspace))?.kind, 'node');
        assert.deepEqual((await discoverProjectChecks(workspace)).map(c => [c.id, c.timeoutMs]), [['node:typecheck', 60000], ['node:lint', 120000], ['node:test', 120000], ['node:build', 120000]]);
        await fs.writeFile(path.join(workspace, 'package.json'), '{}');
        assert.deepEqual(await discoverProjectChecks(workspace), []);
    }
    finally {
        await fs.rm(workspace, { recursive: true, force: true });
    }
});
test('diagnostic uncertainty and basic language support are explicit', () => {
    for (const adapter of PROJECT_ADAPTERS) {
        assert.equal(adapter.explain('fixture failure').category, 'unknown');
        assert.equal(adapter.explain('cargo: command not found').category, 'environment');
        assert.equal(adapter.support, adapter.kind === 'node' ? 'full' : 'basic');
    }
});
