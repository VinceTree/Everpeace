import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const en = JSON.parse(await readFile(new URL('../src/localization/en.json', import.meta.url), 'utf8'));
const zh = JSON.parse(await readFile(new URL('../src/localization/zh-CN.json', import.meta.url), 'utf8'));
assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'Language key sets differ');
const parameters = text => [...new Set(text.match(/\{p\d+\}/g) ?? [])].sort();
for (const key of Object.keys(en)) {
    assert.equal(typeof zh[key], 'string', key);
    assert.ok(zh[key].trim(), key);
    assert.deepEqual(parameters(en[key]), parameters(zh[key]), key + ' interpolation differs');
}
console.log('Language keys and interpolation parameters match: ' + Object.keys(en).length);
await import('./check-host-copy.mjs');
