import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { stripVTControlCharacters } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { ModelRegistry, RegisteredModel } from '../storage/model-registry.js';
import { SessionStore } from '../storage/session-store.js';
import { loadPermissionPolicy } from '../permissions/policy.js';
import { createProductionAgent, createProductionCommandExecutor, createProductionWorkflowAgentIO, type ProductionAgentHandle } from '../runtime/production.js';
import { CodingWorkflowRuntime } from '../workflow/runtime.js';
import { CodingTaskRunner } from '../workflow/task-runner.js';
import type { SessionGoal } from '../storage/session-store.js';
import { projectTaskStatus, type TaskStatusSnapshot } from '../status/task-status.js';
import { uiText, displayStatus } from '../localization/messages.js';
import { changeLanguage, isLanguagePreference } from '../localization/language.js';
import { redactSecretsPreservingLayout } from '../util/redact-secrets.js';
import { ResourceCleanupError } from '../util/resource-cleanup-error.js';
import type { TaskProgress } from '../workflow/task-progress.js';
import { ApplicationCoordinator, type ApplicationTask } from '../runtime/application-coordinator.js';
import { PersistenceError } from '../storage/persistence-error.js';
import { formatTaskStatus } from '../status/format-task-status.js';
import type { WorkflowState } from '../workflow/types.js';
export interface AccessibleHost {
    readonly interactive: boolean;
    ask(prompt: string, signal?: AbortSignal): Promise<string>;
    write(text: string): void;
    onInterrupt(handler: () => void): () => void;
    close(): void;
}
export function accessibleProcessHost(): AccessibleHost {
    const interactive = stdin.isTTY === true && stdout.isTTY === true;
    const reader = createInterface({ input: stdin, output: stdout, terminal: false });
    return { interactive, ask: (prompt, signal) => reader.question(prompt, signal ? { signal } : {}), write: text => stdout.write(text), onInterrupt(handler) { process.on('SIGINT', handler); process.on('SIGTERM', handler); return () => { process.off('SIGINT', handler); process.off('SIGTERM', handler); }; }, close: () => reader.close() };
}
/** The append-only host supplies interaction; production owns tools, policy and settlement. */
export async function runAccessible(registry: Pick<ModelRegistry, 'resolveAll'>, host: AccessibleHost = accessibleProcessHost()): Promise<number> {
    if (!host.interactive) {
        host.write(uiText('accessible.nonTTY') + '\n');
        host.close();
        return 1;
    }
    const write = (text: string) => host.write(stripVTControlCharacters(redactSecretsPreservingLayout(text)));
    let closing = false, active: AbortController | undefined, asking: AbortController | undefined, handle: ProductionAgentHandle | undefined, sessionId: string | undefined, exitCode = 0;
    const coordinator = new ApplicationCoordinator<ProductionAgentHandle>();
    const interrupt = () => { if (active) {
        active.abort();
        coordinator.cancelTask();
        write(uiText('task.cleaning') + '\n');
    }
    else
        closing = true; asking?.abort(); };
    const remove = host.onInterrupt(interrupt);
    const ask = async (prompt: string, signal?: AbortSignal): Promise<string> => { asking = new AbortController(); const combined = signal ? AbortSignal.any([signal, asking.signal]) : asking.signal; try {
        return await host.ask(prompt, combined);
    }
    finally {
        asking = undefined;
    } };
    const store = new SessionStore(), workspacePath = process.cwd();
    let goal: SessionGoal | undefined, progress: TaskProgress | undefined;
    let last: TaskStatusSnapshot = projectTaskStatus({ active: false });
    let taskStartedAt: number | undefined, stageStartedAt: number | undefined, currentTaskId: string | undefined, lastStage: string | undefined, workflowState: WorkflowState | undefined;
    let timelineQueue = Promise.resolve(), timelineFailure: PersistenceError | undefined;
    const append = (kind: 'assistant' | 'system', text: string) => { const id = sessionId; if (!id)
        return; timelineQueue = timelineQueue.then(() => store.appendTimeline(id, { kind, text })).catch(error => { timelineFailure ??= new PersistenceError(uiText('mec4969485835'), error); }); };
    const flush = async () => { await timelineQueue; if (timelineFailure)
        throw timelineFailure; };
    const snapshot = () => { const report = handle?.agent.getLivePerformanceReport(); const used = report ? Object.values(report.usage).reduce((sum, usage) => sum + (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0), 0) : null; return projectTaskStatus({ active: active !== undefined, cancelled: active?.signal.aborted === true, ...(sessionId ? { sessionId } : {}), ...(currentTaskId ? { taskId: currentTaskId } : {}), ...(taskStartedAt === undefined ? {} : { startedAt: taskStartedAt }), ...(stageStartedAt === undefined ? {} : { stageStartedAt }), ...(workflowState ? { workflow: workflowState } : {}), budgets: [{ scope: 'task', limit: null, used, complete: report?.meteringComplete === true, inFlight: lastStage === 'model' }, ...(goal ? [{ scope: 'goal' as const, limit: goal.token_budget, used: goal.tokens_used, complete: goal.usage_complete, inFlight: lastStage === 'model' }] : [])] }); };
    try {
        write(uiText('accessible.title') + '\n');
        const models = (await registry.resolveAll()).available;
        if (!models.length) {
            write(uiText('accessible.noModels') + '\n');
            return 2;
        }
        let model: RegisteredModel = models[0]!;
        if (models.length > 1) {
            models.forEach((m, i) => write(`${i + 1}. ${m.model_name}\n`));
            const selected = Number(await ask(uiText('accessible.model')));
            if (!Number.isInteger(selected) || !models[selected - 1])
                return 2;
            model = models[selected - 1]!;
        }
        let policy = await loadPermissionPolicy(workspacePath), workflow: CodingWorkflowRuntime | undefined;
        const ensureSession = async (prompt: string) => {
            if (handle)
                return;
            const session = await store.create({ title: prompt.slice(0, 60), titlePending: false, workspacePath, model: { id: model.id, model_name: model.model_name, base_url: model.base_url, ...(model.request_settings ? { request_settings: model.request_settings } : {}), ...(model.responses_profile ? { responses_profile: model.responses_profile } : {}) } });
            sessionId = session.id;
            coordinator.attachSession(session.id);
            workflow = new CodingWorkflowRuntime({ workspacePath, async onState(state) { await store.setWorkflow(session.id, state); workflowState = state; last = snapshot(); if (last.stage !== lastStage) {
                    lastStage = last.stage;
                    stageStartedAt = Date.now();
                    write(formatTaskStatus(snapshot())[0] + '\n');
                } } });
            let execute: ReturnType<typeof createProductionCommandExecutor> | undefined;
            const io = createProductionWorkflowAgentIO({ workspacePath, policy: () => policy, workflow, execute: (command, signal, timeout, onOutput) => { if (!execute)
                    throw Error('Executor unavailable'); return execute(command, signal, timeout, onOutput); },
                session: { getId: () => sessionId, getGoal: async () => goal, async setGoal(next) { await store.setGoal(session.id, next); goal = next; }, getTaskProgress: () => progress, async setTaskProgress(next) { await store.setTaskProgress(session.id, next); progress = next; } },
                output: { async assistant(text) { append('assistant', text); await flush(); write(text); write('\n'); } },
                interaction: { async confirm(_kind, _tool, prompt, signal) { write(prompt + '\n'); const answer = await ask(uiText('accessible.approve'), signal); signal?.throwIfAborted(); policy = await loadPermissionPolicy(workspacePath); return answer.trim() === '1'; },
                    async requestUserInput(request, signal) { const answers: Record<string, string> = {}; for (const question of request.questions) {
                        write(question.question + '\n');
                        question.options.forEach((option, i) => write(`${i + 1}. ${option.label}: ${option.description}\n`));
                        const answer = await ask(uiText('accessible.question'), signal);
                        signal?.throwIfAborted();
                        const index = /^[1-9]\d*$/.test(answer.trim()) ? Number(answer.trim()) - 1 : -1;
                        answers[question.id] = question.options[index]?.label ?? answer;
                    } return answers; },
                    async reviewPlan(submitted, signal) { write(submitted.title + '\n' + submitted.plan + '\n'); const answer = await ask(uiText('accessible.approve'), signal); signal?.throwIfAborted(); return answer.trim() === '1' ? 'approve' : 'cancel'; } },
            });
            handle = createProductionAgent({ model, workspacePath, io, sessionStore: store, sessionId: () => sessionId, restore: { async onHistoryAppend(items) { await flush(); await store.appendContext(session.id, items); }, async onUsage(usage) { await store.appendUsage(session.id, usage); }, async onContextCompacted(items, automatic, usage) { await store.compactContext(session.id, items, automatic, usage); }, async onContextPruned(items, metadata) { await store.pruneContext(session.id, items, metadata); }, onPhase(phase) { const next = phase === 'sampling' ? 'model' : phase; if (next !== lastStage) {
                        lastStage = next;
                        stageStartedAt = Date.now();
                        write(displayStatus(next) + '\n');
                    } } } });
            coordinator.setAgent(handle);
            execute = createProductionCommandExecutor({ workspacePath, policy: () => policy, readableRoots: handle.readableRoots });
        };
        while (!closing) {
            let text: string;
            try {
                text = await ask(uiText('accessible.prompt'));
            }
            catch {
                if (closing)
                    break;
                throw Error(uiText('accessible.nonTTY'));
            }
            text = text.trim();
            if (!text)
                continue;
            if (text === '/exit')
                break;
            if (text === '/help') {
                write(uiText('accessible.help') + '\n');
                continue;
            }
            if (text === '/status') {
                write(formatTaskStatus(last).join('\n') + '\n');
                continue;
            }
            if (text.startsWith('/language')) {
                const next = text.split(/\s+/)[1];
                if (isLanguagePreference(next)) {
                    const language = await changeLanguage(next);
                    write(uiText('language.saved', { p0: language }) + '\n');
                }
                else
                    write(uiText('language.help', { p0: 'auto' }) + '\n');
                continue;
            }
            if (text === '/new') {
                await flush();
                await handle?.dispose();
                handle = undefined;
                coordinator.setAgent(undefined);
                coordinator.replaceSession(undefined);
                sessionId = undefined;
                goal = undefined;
                progress = undefined;
                workflowState = undefined;
                last = projectTaskStatus({ active: false });
                continue;
            }
            if (text.startsWith('/') && !text.startsWith('/plan ')) {
                write(uiText('accessible.help') + '\n');
                continue;
            }
            const executePlan = text === '/plan execute', plan = !executePlan && text.startsWith('/plan ');
            let prompt = plan ? text.slice(6) : text;
            active = new AbortController();
            const startedAt = Date.now(), taskId = randomUUID();
            taskStartedAt = startedAt;
            stageStartedAt = startedAt;
            currentTaskId = taskId;
            let task: ApplicationTask<ProductionAgentHandle> | undefined;
            lastStage = undefined;
            try {
                await ensureSession(prompt);
                active.signal.throwIfAborted();
                const admitted = coordinator.beginTask(handle!, plan ? 'plan' : 'default', executePlan);
                if (admitted.status !== 'started') {
                    write(uiText('accessible.noPlan') + '\n');
                    continue;
                }
                task = admitted.task;
                const cancellation = () => coordinator.cancelTask();
                active.signal.addEventListener('abort', cancellation, { once: true });
                if (admitted.approvedPlan)
                    prompt = admitted.approvedPlan.plan;
                const startup = await handle!.prepareMcp?.(active.signal);
                if (startup) {
                    write(startup.prompt + '\n');
                    last = projectTaskStatus({ active: false, approval: true });
                    continue;
                }
                const user = { id: randomUUID(), at: new Date().toISOString(), kind: 'user' as const, text: prompt };
                await store.appendTimeline(sessionId!, user);
                const executor = createProductionCommandExecutor({ workspacePath, policy: () => policy, readableRoots: handle!.readableRoots });
                const runner = new CodingTaskRunner({ agent: handle!.agent, workflow: workflow!, host: { executeVerification: executor, getGoal: async () => goal, async addGoalTime(seconds) { if (!goal)
                            return undefined; goal = { ...goal, time_used_seconds: goal.time_used_seconds + seconds }; await store.setGoal(sessionId!, goal); return goal; }, onSystemMessage: message => { append('system', message); write(message + '\n'); } } });
                const result = await runner.run({ text: prompt, mode: plan ? 'plan' : 'default', source: 'user', signal: task.signal });
                await flush();
                if (result.disposition === 'plan_approved' && result.agentResult.approvedPlan && result.agentResult.approvedPlanTitle)
                    coordinator.approvePlan(task, { plan: result.agentResult.approvedPlan, title: result.agentResult.approvedPlanTitle });
                const success = result.disposition === 'plan_approved' || result.workflowResult?.state.result === 'verified' || result.workflowResult?.state.result === 'no_changes';
                const report = handle!.agent.getPerformanceReport();
                const requestBudget=handle!.agent.getRequestBudgetSnapshot();
                last = projectTaskStatus({ active: false, taskId, sessionId: sessionId!, startedAt, finishedAt: Date.now(),stageStartedAt:stageStartedAt??startedAt, outcome: success ? 'success' : result.disposition === 'plan_cancelled' ? 'cancelled' : 'failed', ...(result.workflowResult ? { workflow: result.workflowResult.state } : {}),budgets:[...(requestBudget?[{scope:'request' as const,...requestBudget}]:[]),{scope:'task',limit:null,used:report?Object.values(report.usage).reduce((sum,u)=>sum+(u?.inputTokens??0)+(u?.outputTokens??0),0):null,complete:report?.meteringComplete===true},...(goal?[{scope:'goal' as const,limit:goal.token_budget,used:goal.tokens_used,complete:goal.usage_complete}]:[])] });
                write(formatTaskStatus(last).join('\n')+'\n');
                write(uiText('accessible.done', { p0: displayStatus(result.workflowResult?.state.result ?? result.disposition), p1: displayStatus(report?.meteringComplete===true?'complete':'usage_unknown') }) + '\n');
            }
            catch (error) {
                last = projectTaskStatus({ active: false, taskId, startedAt, finishedAt: Date.now(), outcome: error instanceof ResourceCleanupError ? 'cleanup_failed' : active.signal.aborted ? 'cancelled' : 'failed' });
                write(uiText('accessible.failed', { p0: error instanceof ResourceCleanupError ? uiText('task.cleanupFailed') : error instanceof Error ? error.message : String(error) }) + '\n');
                if (error instanceof ResourceCleanupError || error instanceof PersistenceError) {
                    if (task && error instanceof ResourceCleanupError)
                        coordinator.markCleanupFailed(task);
                    exitCode = 1;
                    closing = true;
                }
            }
            finally {
                if (task)
                    coordinator.finishTask(task);
                active = undefined;
            }
        }
    }
    finally {
        try {
            await flush();
        }
        finally {
            try {
                await handle?.dispose();
            }
            finally {
                remove();
                host.close();
            }
        }
    }
    return exitCode;
}
