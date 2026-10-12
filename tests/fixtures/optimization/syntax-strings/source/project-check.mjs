import {execFileSync} from 'node:child_process';
for(const file of ['a.mjs','b.mjs'])execFileSync(process.execPath,['--check',file],{stdio:'inherit'});
console.log('Project syntax checks passed; behavioral assertions are evaluator-owned.');
