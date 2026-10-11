import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// Deterministic fixtures; evaluation code is outside every model workspace.
const root = path.resolve("tests/fixtures/expanded");
const cases = [
  { id: "monorepo-build-order", prompt: "Repair the 100-package synthetic pnpm workspace dependency and build-order regressions. Keep all packages and build each dependency before its consumer.", files: {
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "build.mjs": "import {readdir,readFile} from 'node:fs/promises';\nimport {pathToFileURL} from 'node:url';\nexport async function build(root){ const names=(await readdir(root+'/packages')).sort(); const built={}; for(const name of names){ const manifest=JSON.parse(await readFile(root+'/packages/'+name+'/package.json','utf8')); const module=await import(pathToFileURL(root+'/packages/'+name+'/index.mjs').href); const deps=Object.keys(manifest.dependencies??{}).map(dep=>{if(!(dep in built))throw new Error('dependency not built: '+dep);return built[dep]});built[manifest.name]=module.build(deps); } return built; }\n",
  }, edits: { "build.mjs": [".sort()", ".sort().reverse()"] } },
  { id: "fullstack-contract", prompt: "Fix the React frontend/Node HTTP API profile contract mismatch. Preserve the API's profile.displayName contract and render the real returned value.", files: {
    "api.mjs": "import http from 'node:http';\nexport function server(){return http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({profile:{displayName:'Ada'}}));});}\n",
    "profile.mjs": "export function Profile({React,response}){return React.createElement('span',null,response.profile.displayName);}\n",
  }, edits: { "profile.mjs": ["response.profile.displayName", "response.user.name"] } },
  { id: "typescript-generics", prompt: "Fix readonly array flattening, distributive union wrapping, and number overload inference without any or assertions that hide type errors.", files: {
    "types.ts": "export type Flatten<T> = T extends readonly (infer U)[] ? U : T;\nexport type Wrapped<T> = T extends unknown ? {value:T} : never;\nexport function echo(value:string):string;\nexport function echo(value:number):number;\nexport function echo(value:string|number):string|number{return value;}\n",
  }, edits: { "types.ts": ["T extends readonly (infer U)[]", "T extends (infer U)[]"] }, extra: { "types.ts": [["T extends unknown ? {value:T} : never", "[T] extends [unknown] ? {value:T} : never"], ["echo(value:number):number", "echo(value:number):string"]] } },
  { id: "react-state-race", prompt: "Fix stale asynchronous React profile updates across changing IDs and unmount. The most recent active request must win without dropping valid updates.", files: {
    "profile.mjs": "export function useProfile(React,load,id){const [value,setValue]=React.useState(null);React.useEffect(()=>{let active=true;load(id).then(result=>{if(active)setValue(result);});return()=>{active=false;};},[load,id]);return value;}\n",
  }, edits: { "profile.mjs": ["if(active)setValue(result)", "setValue(result)"] } },
  { id: "sqlite-migration", prompt: "Fix the SQLite migration so user data survives up/down, repeated runs are idempotent, and failed migration steps roll back schema and version changes.", files: {
    "migration.mjs": "export function migrate(db,direction){const columns=()=>db.prepare('PRAGMA table_info(users)').all().map(row=>row.name);db.exec('BEGIN');try{if(direction==='up'){if(!columns().includes('email'))db.exec(\"ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''\");db.exec('PRAGMA user_version=1');}else{if(columns().includes('email'))db.exec('ALTER TABLE users DROP COLUMN email');db.exec('PRAGMA user_version=0');}db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}}\n",
  }, edits: { "migration.mjs": ["if(!columns().includes('email'))db.exec(\"ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''\")", "db.exec(\"DROP TABLE users; CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,email TEXT NOT NULL DEFAULT '')\")"] } },
  { id: "cross-file-interface", prompt: "Finish the calculateInvoice public interface refactor across consumers and public declarations. Return {total,currency}, keep quantity calculation, and remove stale calculateTotal references.", files: {
    "pricing.mjs": "export function calculateInvoice(items){return {total:items.reduce((sum,item)=>sum+item.price*item.quantity,0),currency:'USD'};}\n",
    "client.mjs": "import {calculateInvoice} from './pricing.mjs';\nexport function checkout(items){return calculateInvoice(items);}\n",
    "index.d.ts": "export function calculateInvoice(items:{price:number;quantity:number}[]):{total:number;currency:string};\n",
  }, edits: { "client.mjs": ["calculateInvoice", "calculateTotal"], "index.d.ts": ["calculateInvoice", "calculateTotal"] } },
  { id: "windows-path-boundary", prompt: "Fix Windows path containment with Unicode, spaces, case-insensitive drive paths, UNC paths, traversal and sibling-prefix escapes. Cross-drive targets must remain outside.", files: {
    "paths.mjs": "import path from 'node:path';\nexport function within(root,target){const base=path.win32.resolve(root).toLowerCase().replace(/\\\\+$/u,'');const candidate=path.win32.resolve(target).toLowerCase();return candidate===base||candidate.startsWith(base+'\\\\');}\n",
  }, edits: { "paths.mjs": ["candidate===base||candidate.startsWith(base+'\\\\')", "candidate.startsWith(base)"] } },
  { id: "typescript-python-protocol", prompt: "Repair the TypeScript/Python JSON subprocess protocol and cancellation. Preserve requestId and total, await process closure, and reject cancellation without leaving a child running.", files: {
    "worker.py": "import json,sys,time\nrequest=json.loads(sys.stdin.readline())\ntime.sleep(request.get('delay',0))\nprint(json.dumps({'requestId':request['requestId'],'total':sum(request['values'])}),flush=True)\n",
    "client.ts": "import {spawn} from 'node:child_process';\nexport function runWorker(script:string,input:Record<string,unknown>,signal?:AbortSignal):Promise<Record<string,unknown>>{return new Promise((resolve,reject)=>{const child=spawn(process.platform==='win32'?'python':'python3',[script],{stdio:['pipe','pipe','pipe'],windowsHide:true});let output='';let cancelled=false;const abort=()=>{cancelled=true;child.kill();};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();child.stdout.on('data',chunk=>{output+=chunk;if(output.length>100000)child.kill();});child.stderr.resume();child.once('error',reject);child.once('close',code=>{signal?.removeEventListener('abort',abort);if(cancelled){reject(Object.assign(new Error('cancelled'),{name:'AbortError'}));return;}if(code!==0){reject(new Error('worker failed'));return;}try{resolve(JSON.parse(output));}catch(error){reject(error);}});child.stdin.end(JSON.stringify(input)+String.fromCharCode(10));});}\n",
  }, edits: { "worker.py": ["request['requestId']", "request['request_id']"], "client.ts": ["cancelled=true;child.kill();", "cancelled=true;"] } },
];
function patch(before, after) {
  return Object.keys(before).filter((file) => before[file] !== after[file]).sort().map((file) => {
    const oldLines = before[file].trimEnd().split("\n"), newLines = after[file].trimEnd().split("\n");
    return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n${oldLines.map((line)=>'-'+line).join('\n')}\n${newLines.map((line)=>'+'+line).join('\n')}\n`;
  }).join("");
}
const tasks = [];
for (const item of cases) {
  const files = { "package.json": JSON.stringify({ name: item.id, private: true, type: "module", scripts: { test: "node check.mjs" } }, null, 2) + "\n", "check.mjs": "console.log('Use the independent acceptance verifier for task scoring.');\n", ...item.files };
  if (item.id === "monorepo-build-order") {
    for (let index = 0; index < 100; index++) {
      const name = `pkg-${String(index).padStart(3,'0')}`;
      files[`packages/${name}/package.json`] = JSON.stringify({ name, version: "1.0.0", type: "module", ...(index ? { dependencies: { [`pkg-${String(index-1).padStart(3,'0')}`]: "workspace:*" } } : {}) }) + "\n";
      files[`packages/${name}/index.mjs`] = "export function build(dependencies){return dependencies.length?dependencies[0]+1:0;}\n";
    }
  }
  const seeded = { ...files };
  for (const [file,[from,to]] of Object.entries(item.edits)) seeded[file] = seeded[file].replaceAll(from,to);
  for (const [file,edits] of Object.entries(item.extra ?? {})) for (const [from,to] of edits) seeded[file] = seeded[file].replaceAll(from,to);
  if (item.id === "monorepo-build-order") seeded["packages/pkg-050/package.json"] = seeded["packages/pkg-050/package.json"].replace("pkg-049","pkg-051");
  const directory = path.join(root,item.id,"source");
  for (const [file,contents] of Object.entries(files)) { await mkdir(path.dirname(path.join(directory,file)),{recursive:true});await writeFile(path.join(directory,file),contents); }
  const hash=createHash('sha256');for(const file of Object.keys(files).sort())hash.update(file).update('\0').update(String(Buffer.byteLength(files[file]))).update('\0').update(files[file]);
  await writeFile(path.join(root,item.id,"seed.patch"),patch(files,seeded));
  await writeFile(path.join(root,item.id,"reference.patch"),patch(seeded,files));
  const verify={command:"node",args:["${FIXTURE_ROOT}/verify.mjs",item.id,"${WORKSPACE}"],timeoutMs:60000};
  tasks.push({id:item.id,prompt:item.prompt,workspacePath:`.everpeace-benchmark/${item.id}`,tags:["expanded","synthetic",item.id],source:{repositoryUrl:"https://github.com/VinceTree/Everpeace",commit:"synthetic",issue:item.id,sourceType:"synthetic",license:"Apache-2.0",fixtureDirectory:`${item.id}/source`,fixtureDigest:hash.digest('hex')},verification:verify,acceptance:verify,fixture:{setup:{command:"node",args:["${FIXTURE_ROOT}/setup.mjs",item.id],timeoutMs:10000},pristineVerification:verify,seedPatch:`${item.id}/seed.patch`,referencePatch:`${item.id}/reference.patch`,seedFailureContains:["ERR_ASSERTION"]}});
}
const helper = "src/conpty_console_list_agent.ts";
await mkdir(path.join(root,"node-pty-helper-952"),{recursive:true});
await writeFile(path.join(root,"node-pty-helper-952","seed.patch"),"diff --git a/benchmark-helper-marker.txt b/benchmark-helper-marker.txt\nnew file mode 100644\n--- /dev/null\n+++ b/benchmark-helper-marker.txt\n@@ -0,0 +1 @@\n+Upstream issue #952: deterministic helper AttachConsole failure; production source is not seeded.\n");
await writeFile(path.join(root,"node-pty-helper-952","reference.patch"),`diff --git a/${helper} b/${helper}\n--- a/${helper}\n+++ b/${helper}\n@@ -13,1 +13,6 @@\n-const consoleProcessList = getConsoleProcessList(shellPid);\n+let consoleProcessList: number[] = [];\n+try {\n+  consoleProcessList = getConsoleProcessList(shellPid);\n+} catch {\n+  // The console may have closed before the helper attached.\n+}\n`);
const verify={command:"node",args:["${FIXTURE_ROOT}/verify.mjs","node-pty-helper-952","${WORKSPACE}"],timeoutMs:60000};
tasks.push({id:"node-pty-helper-952",prompt:"Fix node-pty #952's console-list helper exception path at the pinned revision. A lost AttachConsole race must send an empty list and exit cleanly; preserve normal results. This task only scores the helper exception path, not the complete detached-process sweep.",workspacePath:".everpeace-benchmark/node-pty-helper-952",tags:["expanded","upstream_issue","windows"],source:{repositoryUrl:"https://github.com/microsoft/node-pty",commit:"1def5774632305246fe21f0f69e23a664d6c5910",issue:"https://github.com/microsoft/node-pty/issues/952",sourceType:"upstream_issue",license:"MIT"},verification:verify,acceptance:verify,fixture:{setup:{command:"node",args:["${FIXTURE_ROOT}/setup.mjs","node-pty-helper-952"],timeoutMs:10000},pristineVerification:{...verify,args:[...verify.args,"normal"]},seedPatch:"node-pty-helper-952/seed.patch",referencePatch:"node-pty-helper-952/reference.patch",seedFailureContains:["ERR_ASSERTION"]}});
await writeFile("docs/benchmark/EXPANDED_TASKS.json",JSON.stringify({version:1,tasks},null,2)+"\n");
// The evaluator uses these exact host dependencies; the complete lock is frozen with the fixtures.
await writeFile(path.join(root,"pnpm-lock.yaml"),await readFile("pnpm-lock.yaml"));
console.log(`Generated ${tasks.length} frozen expanded task definitions.`);
