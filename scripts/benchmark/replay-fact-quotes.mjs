// Offline receipt replay through the current production extractor. No provider is created.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { extractMemoryBundle } from '../../src/memory/facts.ts';
import { historyTurn } from '../../src/benchmark/memory-data.ts';

const [rootArg, outputArg] = process.argv.slice(2);
if (!rootArg || !outputArg) throw Error('Supply a finished pilot and a new output directory');
const root = path.resolve(rootArg), output = path.resolve(outputArg);
if (output === root || output.startsWith(root + path.sep)) throw Error('Keep replay outside the campaign');
const hashes = {};
const read = async file => { const bytes = await readFile(file); hashes[file] = createHash('sha256').update(bytes).digest('hex'); return JSON.parse(bytes); };
const manifest = await read(path.join(root, 'manifest.json'));
await read(path.join(root, 'run-state.json'));
const questions = await read(path.join(root, 'history.json'));
const requests = new Map();
for (const name of await readdir(path.join(root, 'requests'))) if (name.endsWith('.json')) {
  const row = await read(path.join(root, 'requests', name)); requests.set(row.key, row);
}
const rows = [];
for (const item of manifest.planned.filter(i => i.arm === 'fact-memory')) {
  const q = questions.find(q => q.id === item.questionId);
  let index = 0, facts = 0, rejected = 0, sessions = 0, replayed = 0;
  const uncaptured = new Error('No captured response; never call a model');
  const client = { responses: { async create() {
    const record = requests.get(`${item.key}:extract:${index++}`);
    if (!record?.response) throw uncaptured;
    replayed++; return record.response;
  } } };
  for (let i = 0; i < q.history.length; i++) {
    const session = q.history[i], turn = historyTurn(session, 'offline-replay', `${item.key}:${i}`);
    turn.messages = session.messages.map((m, n) => ({ role: m.role, text: m.content, messageTime: session.date, sourceId: `${session.id}:${n}` }));
    try {
      const bundle = await extractMemoryBundle({ turn, client, model: manifest.model.rawModelId, captureLessons: false });
      facts += bundle.facts.length; rejected += bundle.rejectedFacts ?? 0; sessions++;
    } catch (error) { if (error === uncaptured) break; throw error; }
  }
  rows.push({ questionId: q.id, capturedSessionsReplayed: sessions, capturedRequestsReplayed: replayed, acceptedFacts: facts, rejectedFacts: rejected,
    completeHistoryAvailable: sessions === q.history.length, answerEvaluated: false });
}
await mkdir(output, { recursive: false });
const result = { modelRequests: 0, productionLogic: true, scope: 'Only previously captured prefixes; no complete-history or QA improvement claim',
  rows, sourceHashes: hashes, extractorSha256: createHash('sha256').update(await readFile(new URL('../../src/memory/facts.ts', import.meta.url))).digest('hex') };
await writeFile(path.join(output, 'replay.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ modelRequests: 0, questions: rows.length, acceptedFacts: rows.reduce((n,r) => n+r.acceptedFacts,0), rejectedFacts: rows.reduce((n,r) => n+r.rejectedFacts,0), completeHistories: rows.filter(r=>r.completeHistoryAvailable).length }));
