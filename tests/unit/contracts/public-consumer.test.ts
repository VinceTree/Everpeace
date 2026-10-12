import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
const run=promisify(execFile);
test('frozen consumers read both original versions and the built public CLI/SDK',async()=>{
  await fs.mkdir(path.join(process.cwd(),'.cache'),{recursive:true});
  const root=await fs.mkdtemp(path.join(process.cwd(),'.cache','public-consumer-'));
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'everpeace-public-scope-'));
  try{
    const original=JSON.parse(await fs.readFile('tests/fixtures/public-contract/integrity.json','utf8')) as {files:Record<string,string>};
    for(const [name,hash]of Object.entries(original.files))assert.equal(createHash('sha256').update(await fs.readFile('tests/fixtures/public-contract/'+name)).digest('hex'),hash,'Frozen consumer fixture changed');
    const {consume}=await import('../../fixtures/public-contract/consumer-v1.mjs');
    for(const version of [1,2])consume(await fs.readFile('tests/fixtures/public-contract/v'+version+'.jsonl','utf8'),version);
    assert.throws(()=>consume('{"schema_version":1,"type":"assistant_message","timestamp":"2026-10-12T00:00:00Z","text":"finished"}\n'));
    await fs.copyFile('package.json',path.join(root,'package.json'));
    if (process.platform === 'win32') for (const [kind, executable] of [['files', 'everpeace-files.exe'], ['process', 'everpeace-process.exe']]) {
      const relative = `native/${kind}/bin/win32-${process.arch}/${executable}`;
      await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      for (const suffix of ['', '.sha256']) await fs.copyFile(relative + suffix, path.join(root, relative + suffix));
    }
    await fs.copyFile('tests/fixtures/public-contract/sdk-consumer.mjs',path.join(root,'sdk-consumer.mjs'));
    const compiler=path.resolve('node_modules/typescript/bin/tsc');
    await run(process.execPath,[compiler,'-p','tsconfig.build.json','--outDir',path.join(root,'dist')],{windowsHide:true,timeout:60000});
    const isolation=path.join(root,'home');await fs.mkdir(isolation);
    const env={...process.env,APPDATA:isolation,LOCALAPPDATA:isolation,USERPROFILE:isolation,HOME:isolation,XDG_CONFIG_HOME:isolation,XDG_STATE_HOME:isolation,CODEX_HOME:path.join(root,'codex'),EVERPEACE_CONSUMER_WORKSPACE:workspace,EVERPEACE_LANG:'en'};
    const chineseHelp=await run(process.execPath,[path.join(root,'dist/cli/index.js'),'--lang','zh-CN','--help'],{env,windowsHide:true,timeout:20000});
    assert.match(chineseHelp.stdout,/用法|使用/);assert.match(chineseHelp.stdout,/--accessible/);assert.equal(chineseHelp.stdout.includes('\u001b'),false);
    const nonTty=await run(process.execPath,[path.join(root,'dist/cli/index.js'),'--lang','zh-CN','--accessible'],{env,windowsHide:true,timeout:20000}).catch(error=>error as {stdout:string;stderr:string;code:number});
    assert.equal('code'in nonTty?nonTty.code:0,1);assert.match(nonTty.stderr,/exec --json/);assert.equal(nonTty.stdout.includes('\u001b')||nonTty.stderr.includes('\u001b'),false);
    for(const version of [1,2]){
      const command=run(process.execPath,[path.join(root,'dist/cli/index.js'),'exec','fixture','--json',...(version===2?['--team']:[])],{env,windowsHide:true,timeout:20000});
      command.child.stdin?.end();
      const result=await command.catch(error=>error as {stdout:string;stderr:string;code:number});
      assert.equal('code'in result?result.code:0,2);const events=consume(result.stdout,version);assert.equal(events.at(-1)?.status,'configuration_error');assert.equal(events.at(-1)?.error_code,'CONFIGURATION_ERROR');
    }
    const sdk=await run(process.execPath,[path.join(root,'sdk-consumer.mjs')],{env,windowsHide:true,timeout:45000});assert.match(sdk.stdout,/Public SDK consumer passed/u);
  }finally{assert.ok(root.startsWith(path.join(process.cwd(),'.cache','public-consumer-')));assert.equal(path.dirname(workspace),os.tmpdir());await fs.rm(root,{recursive:true,force:true});await fs.rm(workspace,{recursive:true,force:true});}
});
