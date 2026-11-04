// Offline only: real Session/Memory storage, fixed responses, no provider or credentials.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { sourceChainEvidence } from '../../tests/fixtures/memory-source-chain.ts';
import { SessionHistoryRuntime } from '../../src/storage/session-history.ts';
import { memoryIdentity } from '../../src/benchmark/memory-campaign.ts';

if (!process.argv[2]) throw Error('Supply a new evidence directory');
const root = path.resolve(process.argv[2]);
await mkdir(path.dirname(root), { recursive: true });
await mkdir(root); // Refuse to overwrite prior evidence.
const identityBefore = await memoryIdentity();
const inputs = {};
for (const file of ['tests/fixtures/memory-source-chain.ts', 'src/memory/facts.ts', 'src/storage/session-history.ts', 'src/storage/session-message.ts']) {
  const bytes = await readFile(file);
  inputs[file] = createHash('sha256').update(bytes).digest('hex');
}
// Record the actual bounded reads, including expected denials, without altering their behavior.
const reads = [], originalCall = SessionHistoryRuntime.prototype.call;
SessionHistoryRuntime.prototype.call = async function(name, argumentsJson, signal) {
  const result = await originalCall.call(this, name, argumentsJson, signal);
  reads.push(structuredClone({ tool: name, arguments: JSON.parse(argumentsJson), result }));
  return result;
};
let result;
try { result = await sourceChainEvidence(path.join(root, 'fixture')); }
finally { SessionHistoryRuntime.prototype.call = originalCall; }
const readBytes = JSON.stringify(reads, null, 2);
await writeFile(path.join(root, 'history-reads.json'), readBytes, { flag: 'wx' });
inputs['history-reads.json'] = createHash('sha256').update(readBytes).digest('hex');
const oldPilot = path.resolve('.cache/memory-fact-preservation/pilot-001');
const bytes = await readFile(path.join(oldPilot, 'manifest.json'));
const pilot = JSON.parse(bytes);
const identity = await memoryIdentity();
if (JSON.stringify(identity) !== JSON.stringify(identityBefore)) throw Error("Candidate changed during source proof");
const plan = { candidate: identity, sourcePilot: oldPilot, sourceManifestSha256: createHash('sha256').update(bytes).digest('hex'),
  planned: pilot.planned, smokeIds: pilot.smokeIds, tokenBudget: 'UNAUTHORIZED', liveAuthorized: false,
  executableCampaign: false, holdoutPlanned: 0, fullBatchPlanned: 0, sourceIdsAreBenchmarkIds: true };
await writeFile(path.join(root, 'next-plan.json'), JSON.stringify(plan, null, 2), { flag: 'wx' });
await writeFile(path.join(root, 'evidence.json'), JSON.stringify({ ...result, identity, inputs, createdAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
const count = label => result.rows.filter(row => row.result === label).length;
await writeFile(path.join(root, 'report.md'), `# Memory 来源链离线验证\n\n固定响应验证，不代表模型问答质量；外部模型请求为零。\n\n精确绑定场景 ${count('exact_binding')}，原文回读场景 ${count('exact_read')}，搜索回退 ${count('search_fallback')}，来源不可用 ${count('source_unavailable')}，回读不一致 ${result.readMismatches}。\n\n| 场景 | 结果 |\n| --- | --- |\n${result.rows.map(row => `| ${row.name} | ${row.result} |`).join('\n')}\n\n下一轮只准备六项 smoke 与 12 题两组的清单，预算未授权，无可执行 live 批次。原实验不改写。\n`, { flag: 'wx' });
console.log(JSON.stringify({ root, ...result, rows: result.rows.length }));
