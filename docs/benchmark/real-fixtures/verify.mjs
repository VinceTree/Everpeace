import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire, Module } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const [, , id, workspace, mode = 'acceptance'] = process.argv;
const file = name => path.join(workspace, name);
const text = name => readFileSync(file(name), 'utf8');
const pack = JSON.parse(text('package.json'));
const baseline = mode === 'baseline' || mode === 'regression';
const load = name => import(pathToFileURL(file(name)).href);
const require = createRequire(import.meta.url);
function dayjs() {
  const ts = require('typescript-evaluator');
  const original = Module._extensions['.js'];
  Module._extensions['.js'] = (module, filename) => {
    if (!filename.startsWith(file('src') + path.sep)) return original(module, filename);
    const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } });
    module._compile(compiled.outputText, filename);
  };
  const local = createRequire(file('package.json'));
  const api = local('./src/index.js').default;
  api.extend(local('./src/plugin/utc/index.js').default);
  api.extend(local('./src/plugin/timezone/index.js').default);
  api.extend(local('./src/plugin/updateLocale/index.js').default);
  return api;
}
async function chalkRegression() {
  const api = await load('source/index.js');
  const Chalk = api.Chalk ?? api.default.Instance;
  const style = new Chalk({ level: 1 });
  assert.equal(style.red('x'), '\u001B[31mx\u001B[39m');
  assert.equal(new Chalk({ level: 0 }).red('x'), 'x');
  assert.equal(style.bold.red('x').includes('x'), true);
  return api;
}
async function commanderRegression() {
  const api = await load('index.js');
  const cmd = new api.Command().exitOverride().configureOutput({ writeOut() {}, writeErr() {} });
  cmd.option('-p, --port <number>', 'port', Number).option('-v, --verbose');
  cmd.parse(['--port', '42', '-v'], { from: 'user' });
  assert.deepEqual(cmd.opts(), { port: 42, verbose: true });
  assert.ok(cmd.helpInformation().includes('--port'));
  return api;
}
function detectColor(environment, flags = []) {
  const program = `Object.defineProperty(process,'platform',{value:'linux'}); const {createSupportsColor}=await import(${JSON.stringify(pathToFileURL(file('source/vendor/supports-color/index.js')).href)}); const color=createSupportsColor({isTTY:${environment.TF_BUILD ? 'false' : 'true'}}); console.log(JSON.stringify(color ? color.level : 0));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, '--', ...flags], { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...environment }, windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}
if (id.startsWith('chalk-')) {
  const api = await chalkRegression();
  if (!baseline) {
    if (id.includes('browser-642')) {
      const url = pathToFileURL(file('source/vendor/supports-color/browser.js')).href;
      for (const [navigator, expected] of [[undefined, false], [{ userAgentData: { brands: [{ brand: 'Chromium', version: '100' }] }, userAgent: '' }, 3], [{ userAgent: 'Chrome/90' }, 1], [{ userAgent: 'Firefox/120' }, false]]) {
        const program = `delete globalThis.navigator;${navigator ? `globalThis.navigator=${JSON.stringify(navigator)};` : ''}const api=await import(${JSON.stringify(url)});console.log(JSON.stringify(api.default.stdout && api.default.stdout.level));`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', windowsHide: true });
        assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout.trim()), expected);
      }
    } else if (id.includes('ansi256')) {
      const style = new api.Chalk({ level: 1 });
      assert.equal(style.ansi256(196)('x'), '\u001B[91mx\u001B[39m');
      assert.equal(style.bgAnsi256(196)('x'), '\u001B[101mx\u001B[49m');
      assert.equal(new api.Chalk({ level: 2 }).ansi256(196)('x'), '\u001B[38;5;196mx\u001B[39m');
    } else if (id.includes('579')) {
      assert.equal(detectColor({ TF_BUILD: '1', AGENT_NAME: 'agent' }), 1);
      assert.equal(detectColor({ CI: 'true', GITHUB_ACTIONS: 'true' }), 3);
      const browser = file('source/vendor/supports-color/browser.js');
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `Object.defineProperty(globalThis,'navigator',{value:{userAgentData:{brands:[{brand:'Chromium',version:'100'}]},userAgent:''},configurable:true});const api=await import(${JSON.stringify(pathToFileURL(browser).href)}); console.log(JSON.stringify(api.default.stdout.level));`], { encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout.trim()), 3);
    } else if (id.includes('603')) assert.equal(detectColor({ CI: 'true', GITEA_ACTIONS: 'true' }), 3);
    else if (id.includes('vendor-migration')) {
      assert.equal(Object.keys(pack.dependencies ?? {}).length, 0);
      assert.ok(pack.imports?.['#ansi-styles']?.includes('vendor'));
      assert.ok(pack.imports?.['#supports-color']?.default?.includes('browser'));
      assert.ok(existsSync(file('source/vendor/ansi-styles/index.d.ts')));
      assert.ok(existsSync(file('source/vendor/supports-color/index.d.ts')));
      assert.equal(api.default.hex('#ff0000')('x').includes('x'), true);
    }
  }
} else if (id.startsWith('dayjs-')) {
  const api = dayjs();
  assert.equal(api('2024-01-02').format('YYYY-MM-DD'), '2024-01-02');
  assert.equal(api.utc('2024-01-02T00:00:00Z').tz('Asia/Tokyo').utcOffset(), 540);
  if (!baseline && id.includes('timezone-invalid')) {
    assert.doesNotThrow(() => {
      assert.equal(api('invalid').tz('Europe/Skopje').isValid(), false);
      assert.equal(api.tz('invalid', 'Europe/Skopje').isValid(), false);
      assert.equal(api.tz('invalid', 'Europe/Skopje').$x.$timezone, 'Europe/Skopje');
    });
  } else if (!baseline && id.includes('locale-merge')) {
    api.updateLocale('en', { formats: { LT: 'HH:mm', L: 'MM/DD/YYYY' } });
    api.updateLocale('en', { formats: { L: 'DD/MM/YYYY' } });
    assert.equal(api.Ls.en.formats.LT, 'HH:mm');
    assert.equal(api.Ls.en.formats.L, 'DD/MM/YYYY');
    api.updateLocale('en', { months: Array(12).fill('month') });
    assert.deepEqual(api.Ls.en.months, Array(12).fill('month'));
  } else if (!baseline && id.includes('cross-env')) {
    assert.ok(pack.scripts.test.startsWith('cross-env TZ=Pacific/Auckland'));
    assert.ok(pack.scripts.test.includes('cross-env TZ=Europe/London'));
    assert.ok(pack.scripts.test.includes('cross-env TZ=America/Whitehorse'));
    assert.ok(pack.scripts.test.includes('--coverageThreshold="'));
    assert.ok(pack.devDependencies['cross-env']);
  }
} else {
  const api = await commanderRegression();
  if (!baseline && id.includes('native-util')) {
    const help = new api.Help();
    assert.equal(help.displayWidth('\u001B]8;;https://example.com\u0007hello\u001B]8;;\u0007'), 5);
    assert.ok(text('lib/help.js').includes('stripVTControlCharacters'));
    assert.ok(text('lib/command.js').includes('stripVTControlCharacters'));
  } else if (!baseline && id.includes('esm')) {
    assert.equal(pack.type, 'module');
    assert.equal(pack.exports['.'].require, undefined);
    for (const name of readdirSync(file('lib')).filter(name => name.endsWith('.js'))) assert.ok(!text('lib/' + name).includes('module.exports'));
    assert.ok(!existsSync(file('esm.mjs')));
    assert.ok(text('typings/index.d.ts').includes('import.meta'));
  } else if (!baseline && id.includes('node-tests')) {
    assert.ok(pack.scripts.test.startsWith('node --test'));
    assert.equal(pack.devDependencies.jest, undefined);
    const tests = readdirSync(file('tests')).filter(name => name.endsWith('.test.js'));
    assert.ok(tests.length >= 100);
    for (const name of tests) assert.ok(text('tests/' + name).includes('node:test'), name);
    const result = spawnSync(process.execPath, ['--test', 'tests/options.bool.test.js', 'tests/command.parseOptions.test.js'], { cwd: workspace, windowsHide: true, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } else if (!baseline && id.includes('help-option')) {
    const cmd = new api.Command();
    const option = new api.Option('-H, --HELP', 'custom help');
    assert.equal(typeof cmd.addHelpOption, 'function');
    assert.equal(cmd.addHelpOption(option), cmd);
    assert.ok(cmd.helpInformation().includes('--HELP'));
    assert.ok(cmd.helpInformation().includes('custom help'));
    const disabled = new api.Command().helpOption(false);
    assert.ok(!disabled.helpInformation().includes('--help'));
    assert.ok(text('typings/index.d.ts').includes('addHelpOption'));
  }
}
console.log(JSON.stringify({ id, mode, passed: true }));
