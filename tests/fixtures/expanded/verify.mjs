import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import vm from "node:vm";
import ts from "typescript-evaluator";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const [id, workspace, mode] = process.argv.slice(2);
assert.ok(id && workspace);
const root = path.resolve(workspace);
const load = (file) => import(pathToFileURL(path.join(root,file)).href);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const temporary = await mkdtemp(path.join(tmpdir(),"everpeace-expanded-grade-"));
function transpile(source) { return ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText; }
try {
  if(id==="monorepo-build-order") {
    const {build}=await load("build.mjs"); const built=await build(root);
    assert.equal(Object.keys(built).length,100);assert.equal(built["pkg-099"],99);
    const manifest=JSON.parse(await readFile(path.join(root,"packages/pkg-050/package.json"),"utf8"));assert.deepEqual(manifest.dependencies,{"pkg-049":"workspace:*"});
  } else if(id==="fullstack-contract") {
    const {server}=await load("api.mjs");const service=server();await new Promise(resolve=>service.listen(0,"127.0.0.1",resolve));
    let view;
    try { const address=service.address();assert.ok(address&&typeof address!=="string");const response=await fetch(`http://127.0.0.1:${address.port}/profile`);const data=await response.json();assert.deepEqual(data,{profile:{displayName:"Ada"}});const {Profile}=await load("profile.mjs");await act(async()=>{view=TestRenderer.create(React.createElement(Profile,{React,response:data}));});assert.deepEqual(view.toJSON().children,["Ada"]); }
    finally {if(view)await act(async()=>view.unmount());service.closeAllConnections();await new Promise(resolve=>service.close(resolve));}
  } else if(id==="typescript-generics") {
    const target=path.join(root,"types.ts").replaceAll("\\","/");
    const assertions=`import {echo} from ${JSON.stringify(target)}; import type {Flatten,Wrapped} from ${JSON.stringify(target)};\ntype Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;type Assert<T extends true>=T;type A=Assert<Equal<Flatten<readonly number[]>,number>>;type B=Assert<Equal<Wrapped<string|number>,{value:string}|{value:number}>>;const value:number=echo(12);const text:string=echo('a');\n`;
    const file=path.join(temporary,"assertions.mts");await writeFile(file,assertions);
    const program=ts.createProgram([file],{noEmit:true,strict:true,allowImportingTsExtensions:true,skipLibCheck:true,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,types:[]});
    assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText," ")),[]);
  } else if(id==="react-state-race") {
    const {useProfile}=await load("profile.mjs");const pending=new Map();let observed;
    const request=id=>new Promise(resolve=>pending.set(id,resolve));
    function Probe({id}){observed=useProfile(React,request,id);return React.createElement("span",null,observed);}
    let view;await act(async()=>{view=TestRenderer.create(React.createElement(Probe,{id:"first"}));});
    try {await act(async()=>view.update(React.createElement(Probe,{id:"second"})));await act(async()=>pending.get("second")("fresh"));assert.equal(observed,"fresh");await act(async()=>pending.get("first")("stale"));assert.equal(observed,"fresh");await act(async()=>view.update(React.createElement(Probe,{id:"third"})));await act(async()=>view.unmount());await act(async()=>pending.get("third")("unmounted"));}
    finally {await act(async()=>view.unmount());}
  } else if(id==="sqlite-migration") {
    const {DatabaseSync}=await import("node:sqlite");const {migrate}=await load("migration.mjs");const db=new DatabaseSync(":memory:");
    try {db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT);INSERT INTO users VALUES(1,'Ada');");migrate(db,"up");migrate(db,"up");assert.equal(db.prepare("SELECT name FROM users WHERE id=1").get().name,"Ada");assert.equal(db.prepare("SELECT email FROM users WHERE id=1").get().email,"");migrate(db,"down");migrate(db,"down");assert.equal(db.prepare("SELECT name FROM users WHERE id=1").get().name,"Ada");
      const wrapped={prepare:sql=>db.prepare(sql),exec:sql=>{if(sql==="PRAGMA user_version=1")throw new Error("injected migration fault");db.exec(sql);}};assert.throws(()=>migrate(wrapped,"up"),/injected migration fault/u);assert.equal(db.prepare("PRAGMA table_info(users)").all().some(row=>row.name==="email"),false);assert.equal(db.prepare("PRAGMA user_version").get().user_version,0);assert.equal(db.prepare("SELECT count(*) AS count FROM users").get().count,1);
    } finally {db.close();}
  } else if(id==="cross-file-interface") {
    let client;try{client=await load("client.mjs");}catch{assert.fail("Cross-file public interface mismatch");}
    assert.deepEqual(client.checkout([{price:3,quantity:2},{price:2,quantity:4}]),{total:14,currency:"USD"});
    const declarations=await readFile(path.join(root,"index.d.ts"),"utf8");assert.match(declarations,/calculateInvoice/u);assert.doesNotMatch(declarations,/calculateTotal/u);assert.match(declarations,/total:number;currency:string/u);
  } else if(id==="windows-path-boundary") {
    const {within}=await load("paths.mjs");const base="C:\\Users\\Fixture 文件\\project space";
    for(const target of [base,base+"\\src\\a.ts","c:\\users\\fixture 文件\\PROJECT SPACE\\src\\a.ts"])assert.equal(within(base,target),true,target);
    for(const target of [base+"-other\\a.ts",base+"\\..\\other", "D:\\Users\\Fixture 文件\\project space\\a.ts"])assert.equal(within(base,target),false,target);
    assert.equal(within("\\\\host\\share\\repo","\\\\HOST\\share\\repo\\a"),true);assert.equal(within("\\\\host\\share\\repo","\\\\host\\share\\repo-other\\a"),false);
  } else if(id==="typescript-python-protocol") {
    await promisify(execFile)(process.platform==="win32"?"python":"python3",["--version"],{timeout:30_000,windowsHide:true});
    const compiled=path.join(temporary,"client.cjs");await writeFile(compiled,transpile(await readFile(path.join(root,"client.ts"),"utf8")));
    const {runWorker}=createRequire(import.meta.url)(compiled);let result;try{result=await runWorker(path.join(root,"worker.py"),{requestId:"fixture",values:[1,2,4]});}catch{assert.fail("Subprocess JSON contract mismatch");}assert.deepEqual(result,{requestId:"fixture",total:7});
    const controller=new AbortController();const start=Date.now();const pending=runWorker(path.join(root,"worker.py"),{requestId:"cancel",values:[],delay:5},controller.signal);const timer=setTimeout(()=>controller.abort(),30);
    try {await assert.rejects(pending,{name:"AbortError"});assert.ok(Date.now()-start<2000,"Cancellation must await closure promptly");}finally{clearTimeout(timer);}
  } else if(id==="node-pty-helper-952") {
    const source=await readFile(path.join(root,"src/conpty_console_list_agent.ts"),"utf8");
    for(const fault of mode==="normal"?[false]:[false,true]) {
      let message,exit;let calls=0;
      try {vm.runInNewContext(transpile(source),{exports:{},require:name=>{assert.equal(name,"./utils");return {loadNativeModule:name=>{assert.equal(name,"conpty_console_list");return {module:{getConsoleProcessList:pid=>{calls++;assert.equal(pid,123);if(fault)throw new Error("AttachConsole failed");return [123,456];}}};}};},process:{argv:["node","helper","123"],send:value=>{message=value;},exit:code=>{exit=code;}}},{timeout:1000});}
      catch(error){assert.fail(`Console helper exception escaped: ${error.message}`);}
      assert.equal(calls,1);assert.deepEqual(JSON.parse(JSON.stringify(message)),{consoleProcessList:fault?[]:[123,456]});assert.equal(exit,0);
    }
  } else assert.fail("Unknown expanded task");
  console.log(JSON.stringify({task:id,mode:mode??"acceptance",passed:true,source:id==="node-pty-helper-952"?"upstream_issue":"synthetic"}));
} catch (error) {
  if (error?.code === "ERR_ASSERTION" || error?.code === "ENOENT" || error?.code === "MODULE_NOT_FOUND") throw error;
  assert.fail(`Task behavior failed: ${error.message}`);
} finally {assert.equal(path.dirname(temporary),tmpdir());assert.ok(path.basename(temporary).startsWith("everpeace-expanded-grade-"));await rm(temporary,{recursive:true,force:true});}
