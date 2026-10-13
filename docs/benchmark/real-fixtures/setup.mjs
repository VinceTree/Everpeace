import assert from 'node:assert/strict';
import { access, copyFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const [, , id, workspace] = process.argv;
assert.ok(/^[a-z0-9-]+$/.test(id));
assert.equal(await readFile(path.join(root, 'evaluator-lock.yaml'), 'utf8'), await readFile(path.join(root, '../../../pnpm-lock.yaml'), 'utf8'), 'Evaluator dependency lock changed');
try { await access(path.join(workspace, 'package-lock.json')); }
catch { await copyFile(path.join(root, id, 'package-lock.json'), path.join(workspace, 'package-lock.json')); }
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
execFileSync(process.execPath, [npm, 'ci', '--ignore-scripts', '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund'], { cwd: workspace, windowsHide: true, stdio: 'inherit', timeout: 170000 });
