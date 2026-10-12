const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const [task, workspace] = process.argv.slice(2)
if (!task || !workspace) throw new Error('usage: verify-dayjs.cjs <task> <workspace>')
const scripts = {
  'timezone-gap': `const assert=require('node:assert/strict');const load=v=>require('./'+v).default;const dayjs=load('src');dayjs.extend(load('src/plugin/utc'));dayjs.extend(load('src/plugin/timezone'));assert.equal(dayjs.tz('2021-03-14 02:30','America/New_York').format('YYYY-MM-DD HH:mm Z'),'2021-03-14 03:30 -04:00');`,
  'relative-fallback': `const assert=require('node:assert/strict');const load=v=>require('./'+v).default;const dayjs=load('src');dayjs.extend(load('src/plugin/relativeTime'));dayjs.locale({name:'partial'});const base=dayjs('2020-01-01T00:00:00');assert.equal(base.add(2,'minute').locale('partial').from(base,true),'2 minutes');`,
  'negative-duration': `const assert=require('node:assert/strict');const load=v=>require('./'+v).default;const dayjs=load('src');dayjs.extend(load('src/plugin/duration'));assert.equal(dayjs.duration(-1001).toISOString(),'-PT1.001S');assert.equal(dayjs.duration(0).toISOString(),'P0D');`,
  'duration-clone': `const assert=require('node:assert/strict');const load=v=>require('./'+v).default;const dayjs=load('src');dayjs.extend(load('src/plugin/duration'));const original=dayjs.duration(1000);const clone=original.clone();const localized=original.locale('fr');assert.notEqual(clone,original);assert.notEqual(localized,original);assert.equal(original.$l,'en');`,
}
const script = scripts[task]
if (!script) throw new Error(`unknown Day.js task: ${task}`)
const result = spawnSync(process.execPath, [path.join(workspace, 'node_modules', '@babel', 'node', 'bin', 'babel-node.js'), '-e', script], {
  cwd: workspace,
  encoding: 'utf8',
  env: { ...process.env, BABEL_ENV: 'test' },
})
assert.equal(result.status, 0, result.stderr || result.stdout)
