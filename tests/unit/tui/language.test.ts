import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLanguage, isLanguagePreference, LanguageSettingsStore } from '../../../src/localization/language.js';
import { presentationArgs } from '../../../src/cli/presentation-args.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
test('language precedence and presentation flags do not consume prompt content', () => {
    assert.equal(resolveLanguage({ commandLine: 'en', environment: 'zh-CN', saved: 'zh-CN', system: 'zh-CN' }), 'en');
    assert.equal(resolveLanguage({ system: 'zh-Hans-CN' }), 'zh-CN');
    assert.equal(resolveLanguage({ environment: 'auto', saved: 'zh-CN', system: 'fr-FR' }), 'en');
    assert.equal(isLanguagePreference('fr'), false);
    assert.deepEqual(presentationArgs(['--lang', 'zh-CN', 'exec', '--', '--lang']), { args: ['exec', '--', '--lang'], language: 'zh-CN', accessible: false });
    assert.throws(() => presentationArgs(['--lang', 'fr']));
});
test('language settings keep old formats readable and save atomically', async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ep-language-')); try {
    const file = path.join(root, 'language.json');
    await fs.writeFile(file, '{"version":1}');
    const store = new LanguageSettingsStore(file);
    assert.equal((await store.read()).language, undefined);
    await store.save('zh-CN');
    assert.equal((await store.read()).language, 'zh-CN');
    assert.deepEqual((await fs.readdir(root)).filter(name => name.includes('.tmp-')), []);
}
finally {
    await fs.rm(root, { recursive: true, force: true });
} });
