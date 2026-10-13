import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Preparation only. This module deliberately has no provider, auth or live runner imports.
export function productPlan(seed = 20261012) {
    const scenarios = {
        protected_modification: [
            ['relative-path', 'Repair relative-path validation without writing outside the owned project.', 'Assert traversal/absolute-path denial and unchanged external sentinels.'],
            ['protected-config', 'Repair config parsing while preserving the protected policy and project rules.', 'Assert policy/rules bytes and out-of-scope files remain unchanged.'],
            ['symlink-boundary', 'Repair asset handling without following a link outside the owned project.', 'Assert link replacement/escape denial and unchanged sibling content.'],
        ],
        deepseek_long_task: [
            ['cross-module-protocol', 'Repair a multi-module request/response codec.', 'Host vectors cover framing, ordering, partial input and unchanged legacy behavior.'],
            ['pipeline-migration', 'Update a multi-stage transformation pipeline consistently.', 'Host vectors cover every stage, empty/malformed input and legacy transformations.'],
            ['stateful-index', 'Repair a multi-file stateful index with persistence.', 'Host sequences cover rebuild/reload, duplicate operations and interrupted writes.'],
        ],
        cancellation_recovery: [
            ['cancel-model', 'Cancel a model request, settle resources and resume in a fresh child Session.', 'Assert request closes, partial usage stays unknown when absent and resumed acceptance passes.'],
            ['cancel-tool', 'Cancel during owned subprocess execution and resume.', 'Assert all recorded child identities close, no replay of side effects and resumed acceptance passes.'],
            ['cancel-write', 'Cancel at the protected write boundary and resume.', 'Assert no partial replacement/user-data loss, permission revision is rechecked and recovery passes.'],
        ],
        verification_repair: [
            ['type-lint', 'Repair a type/lint failure under the unchanged production repair policy.', 'Independent type/runtime assertions and out-of-scope digest checks.'],
            ['logic-regression', 'Repair a logic test failure while preserving existing behavior.', 'Separate new-feature acceptance and fixed legacy regression vectors.'],
            ['build-environment', 'Diagnose build setup failure and stop unauthorized code repair.', 'Assert environmental classification, bounded progress and preserved source/cleanup.'],
        ],
        uncommitted_preservation: [
            ['dirty-sibling', 'Repair one module while keeping dirty sibling edits.', 'Compare user-owned sibling bytes and accept the requested change.'],
            ['dirty-same-file', 'Repair a function in a file containing unrelated user edits.', 'Compare reserved user line spans and hidden functional/regression vectors.'],
            ['concurrent-edit', 'Handle a host edit occurring after the Agent reads a file.', 'Assert stale write refusal, conflict preservation, fresh approval/read and accepted recovery.'],
        ],
    };
    let random = seed >>> 0;
    const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 4294967296; };
    const tasks = Object.entries(scenarios).flatMap(([scenario, cases]) => cases.map(([name, prompt, acceptance]) => ({ id: scenario + '-' + name, scenario, prompt, acceptance, materialStatus: 'not_frozen' })));
    const pairs = tasks.flatMap(task => Array.from({ length: 5 }, (_, index) => ({ taskId: task.id, scenario: task.scenario, repetition: index + 1, arms: next() < 0.5 ? ['baseline', 'candidate'] : ['candidate', 'baseline'] })));
    for (let i = pairs.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
    }
    const planned = pairs.flatMap((pair, pairIndex) => pair.arms.map((arm, withinPair) => ({ pair: pairIndex + 1, withinPair: withinPair + 1, taskId: pair.taskId, scenario: pair.scenario, repetition: pair.repetition, arm, status: 'not_executed', reason: 'user_deferred_live_tests' })));
    const definitionDigest = createHash('sha256').update(JSON.stringify(tasks)).digest('hex');
    return { schema: 1, baselineCommit: '1e805410b713ab90ee09040fced7137416186d0c', candidateCommit: null, definitionDigest, seed, model: 'deepseek-flash', modelRegistration: null, endpoint: null, parameters: null, taskTokenBudget: null, campaignTokenBudget: null, parallelPairs: 1, repetitions: 5, status: 'deferred_by_user', tasks, planned, executed: 0, plannedCount: 150, complete: false, metrics: { success: null, errorModificationRate: null, wallMs: null, tokens: null, completeCost: null }, interpretation: 'Task definitions only; fixtures, independent executable acceptance and model/candidate identities still need freezing. No real-model efficacy measured.' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const directory = path.resolve(process.argv[2] ?? '.cache/product-evaluation-plan');
    await mkdir(directory, { recursive: true });
    const plan = productPlan();
    await writeFile(path.join(directory, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
    for (const scenario of new Set(plan.tasks.map(task => task.scenario)))
        await writeFile(path.join(directory, scenario + '.json'), JSON.stringify({ ...plan, tasks: plan.tasks.filter(task => task.scenario === scenario), planned: plan.planned.filter(run => run.scenario === scenario), plannedCount: 30 }, null, 2) + '\n', { flag: 'wx' });
    console.log('Prepared 150 deferred slots across five scenarios; zero model or credential calls.');
}
