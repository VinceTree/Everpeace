// Offline retrieval only. No provider, AuthStorage, capture or extraction is constructed.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LearnedMemoryStore } from '../../src/memory/learned-memory.ts';
import { rankMemoryEntries } from '../../src/memory/retrieval.ts';

const [parentArg, childArg, anchorsArg, outputArg] = process.argv.slice(2);
if (!outputArg) throw Error('Supply <sealed-parent> <sealed-child> <anchor-audit> <new-output>');
const parent = path.resolve(parentArg), child = path.resolve(childArg), output = path.resolve(outputArg);
if ([parent, child].some(root => output === root || output.startsWith(root + path.sep))) throw Error('Keep replay outside experiments');
const hashes = {};
const read = async file => { const bytes = await readFile(file); hashes[file] = createHash('sha256').update(bytes).digest('hex'); return JSON.parse(bytes); };
const manifest = await read(path.join(child, 'manifest.json'));
if (manifest.continuation?.parentRoot !== parent) throw Error('Parent identity differs');
const report = await read(path.join(child, 'report.json'));
const parentStop = await read(path.join(parent, 'run-state.json')), childStop = await read(path.join(child, 'run-state.json'));
const questions = new Map((await read(path.join(child, 'history.json'))).map(q => [q.id, q]));
const rows = [];
for (const plan of manifest.planned.filter(p => p.arm === 'fact-memory')) {
  const old = report.rows.find(r => r.key === plan.key), owner = old.retainedFrom ? path.resolve(old.retainedFrom) : child;
  if (![parent, child].includes(owner)) throw Error('Unexpected retained source');
  const sample = path.join(owner, 'samples', createHash('sha256').update(plan.key).digest('hex'));
  let checkpoint;
  try { checkpoint = await read(path.join(sample, 'fact-build.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const question = questions.get(plan.questionId);
  const full = checkpoint?.next === question.history.length;
  const row = { id: plan.questionId, source: sample, status: old.status, fullHistoryBuilt: full,
    builtSessions: checkpoint?.next ?? 0, plannedSessions: question.history.length, bodyBudgetChars: 8000 };
  if (full) {
    const projects = path.join(sample, 'store', 'projects');
    for (const project of await readdir(projects)) {
      const file = path.join(projects, project, 'facts.json');
      try { await read(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const now = new Date((owner === parent ? parentStop : childStop).stoppedAt);
    const store = new LearnedMemoryStore({ directory: path.join(sample, 'store'), now: () => now });
    const workspace = path.join(sample, 'workspace'), facts = await store.readFacts(workspace);
    const snapshot = await store.snapshot(workspace, question.question, [], 8000);
    const ranked = rankMemoryEntries(facts, question.question, now);
    const lines = snapshot.text.split('\n'), body = snapshot.text ? lines.slice(2, -1).join('\n') : '';
    if (body.length > 8000) throw Error('Body budget exceeded');
    Object.assign(row, { query: question.question, facts: facts.length, oldIds: old.retrieval?.entryIds ?? [],
      newIds: snapshot.entryIds, bodyChars: body.length, text: snapshot.text,
      rank: ranked.map(r => ({ id: r.entry.id, score: r.score })),
      sourceById: Object.fromEntries(facts.map(f => [f.id, f.fact.sourceId.replace(/:\d+$/u, '')])),
      evidenceById: Object.fromEntries(facts.map(f => [f.id, { statement: f.lesson, quote: f.fact.quote }])) });
  }
  rows.push(row);
}
// Labels are read only after retrieval has finished; they are never ranking inputs.
const anchors = (await read(path.resolve(anchorsArg))).audit;
const references = new Map((await read(path.join(child, 'references.json'))).map(r => [r.id, r]));
for (const row of rows.filter(r => r.fullHistoryBuilt)) {
  const gold = references.get(row.id).evidence, sources = ids => new Set(ids.map(id => row.sourceById[id]));
  row.oldGoldSources = gold.filter(id => sources(row.oldIds).has(id));
  row.newGoldSources = gold.filter(id => sources(row.newIds).has(id));
  const anchor = anchors.find(a => a.id === row.id);
  if (anchor) {
    if (!row.evidenceById[anchor.target.id]) throw Error('Anchor is not in the frozen fact store');
    row.anchor = { id: anchor.target.id, quote: anchor.target.quote, oldRank: anchor.targetRank,
      newRank: row.rank.findIndex(r => r.id === anchor.target.id) + 1, oldSelected: row.oldIds.includes(anchor.target.id),
      newSelected: row.newIds.includes(anchor.target.id), quoteInContext: row.text.includes(anchor.target.quote) };
  }
}
// Verify source facts and reports stayed byte-identical during replay.
for (const [file, hash] of Object.entries(hashes)) if (createHash('sha256').update(await readFile(file)).digest('hex') !== hash) throw Error('Input changed during replay');
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
const full = rows.filter(r => r.fullHistoryBuilt), targets = full.filter(r => r.anchor);
const summary = { modelRequests: 0, extractionRequests: 0, qaAccuracy: null, newQaRun: false, budgetChars: 8000,
  fullStores: full.length, partialOrAbsent: rows.length - full.length, anchors: targets.map(r => ({ questionId: r.id, ...r.anchor })),
  oldGoldCoverage: full.reduce((s, r) => s + r.oldGoldSources.length, 0), newGoldCoverage: full.reduce((s, r) => s + r.newGoldSources.length, 0),
  lostGoldSources: full.filter(r => r.oldGoldSources.some(s => !r.newGoldSources.includes(s))).map(r => r.id), hashes };
await writeFile(path.join(output, 'replay.json'), JSON.stringify({ summary, rows }, null, 2), { flag: 'wx' });
await writeFile(path.join(output, 'report.md'), `# Memory 排序离线回放\n\n只复用已提取事实；无模型、无重新提取、无新问答评分。正文预算 8000 字符。完整事实库 ${full.length}，不完整 ${rows.length - full.length}，后者不参与覆盖比较。\n\n| 案例 | 原排名 | 新排名 | 原召回 | 新召回 | 引文进入上下文 |\n| --- | ---: | ---: | --- | --- | --- |\n${targets.map(r => `| ${r.id} | ${r.anchor.oldRank} | ${r.anchor.newRank} | ${r.anchor.oldSelected} | ${r.anchor.newSelected} | ${r.anchor.quoteInContext} |`).join('\n')}\n\nGold Session 覆盖：${summary.oldGoldCoverage} → ${summary.newGoldCoverage}；存在来源覆盖下降的题目：${summary.lostGoldSources.join(', ') || '无'}。来源覆盖不等于答案事实覆盖，召回成功不等于模型答对。\n`, { flag: 'wx' });
console.log(JSON.stringify(summary, (key, value) => key === 'hashes' ? undefined : value));
