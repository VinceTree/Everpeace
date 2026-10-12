import test from 'node:test';
import assert from 'node:assert/strict';
import { runAccessible,sanitizeAccessibleOutput, type AccessibleHost } from '../../../src/cli/accessible.js';
import { setUiLanguage } from '../../../src/localization/language.js';

test('append-only output preserves code indentation and Unicode while removing overwrite controls',()=>{
 assert.equal(sanitizeAccessibleOutput('\u001b[31m中文 é🙂\r\n\tconst value = 1;\b\rnext\u0007\u001b[0m'),'中文 é🙂\n\tconst value = 1;\nnext');
});
test('accessible non-TTY refusal avoids credentials, model requests and terminal controls', async () => {
    let reads = 0, closed = false;
    let text = '';
    const host: AccessibleHost = { interactive: false, ask: async () => { throw Error('No input expected'); }, write: value => { text += value; }, onInterrupt: () => () => { }, close: () => { closed = true; } };
    setUiLanguage('zh-CN');
    try {
        assert.equal(await runAccessible({ resolveAll: async () => { reads++; return { available: [], missing: [] }; } }, host), 1);
        assert.equal(reads, 0);
        assert.equal(closed, true);
        assert.match(text, /exec --json/);
        assert.equal(text.includes('\u001b'), false);
    }
    finally {
        setUiLanguage('en');
    }
});
test('accessible missing-model diagnosis settles without opening a Session', async () => {
    let closed = false, removed = false;
    let text = '';
    const host: AccessibleHost = { interactive: true, ask: async () => { throw Error('No input expected'); }, write: value => { text += value; }, onInterrupt: () => () => { removed = true; }, close: () => { closed = true; } };
    assert.equal(await runAccessible({ resolveAll: async () => ({ available: [], missing: [] }) }, host), 2);
    assert.equal(closed, true);
    assert.equal(removed, true);
    assert.match(text, /login/);
    assert.equal(text.includes('\u001b'), false);
});
