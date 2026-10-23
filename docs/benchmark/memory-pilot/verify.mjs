import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [workspace, sequenceId, stageText] = process.argv.slice(2);
const stage = Number(stageText);
assert.ok(Number.isInteger(stage) && stage >= 1 && stage <= 4);
const catalog = JSON.parse(await readFile(new URL('./tasks.json', import.meta.url), 'utf8'));
const sequence = catalog.sequences.find(value => value.id === sequenceId);
assert.ok(sequence);
const api = await import(pathToFileURL(path.join(workspace, 'src/index.js')).href);
for (const [index, task] of sequence.tasks.slice(0, stage).entries()) {
  for (const [input, expected] of task.cases) {
    const argument = structuredClone(input);
    assert.deepEqual(api[`step${index + 1}`](argument), expected);
    assert.deepEqual(argument, input, 'Inputs must not be mutated');
  }
}
console.log(JSON.stringify({ sequenceId, stage, passed: true }));
