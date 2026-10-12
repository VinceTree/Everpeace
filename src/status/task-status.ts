import type { WorkflowState } from '../workflow/types.js';
export type TaskStage = 'idle' | 'planning' | 'model' | 'tools' | 'verifying' | 'repairing' | 'awaiting_approval' | 'awaiting_input' | 'cancelling' | 'blocked' | 'complete';
export interface TaskStatusFacts {
    readonly taskId?: string;
    readonly sessionId?: string;
    readonly active: boolean;
    readonly cancelled?: boolean;
    readonly cleanupFailed?: boolean;
    readonly approval?: boolean;
    readonly question?: boolean;
    readonly mode?: 'default' | 'plan';
    readonly loopPhase?: string;
    readonly workflow?: WorkflowState;
    readonly startedAt?: number;
    readonly stageStartedAt?: number;
    readonly finishedAt?: number;
    readonly now?: number;
    readonly outcome?: 'success' | 'failed' | 'cancelled' | 'cleanup_failed';
    readonly failure?: 'environment' | 'runtime' | 'limit' | 'persistence';
    readonly operation?: string;
    readonly budgets?: ReadonlyArray<{
        scope: 'request' | 'task' | 'goal';
        limit: number | null;
        used: number | null;
        complete: boolean;
        inFlight?: boolean;
    }>;
}
export interface TaskStatusSnapshot {
    readonly taskId?: string;
    readonly sessionId?: string;
    readonly stage: TaskStage;
    readonly elapsedMs: number;
    readonly stageElapsedMs: number;
    readonly operation?: string;
    readonly blocker: 'approval' | 'input' | 'cleanup' | 'verification' | 'usage_unknown' | 'environment' | 'runtime' | 'limit' | 'persistence' | null;
    readonly recovery: 'continue' | 'reapprove' | 'repair_environment' | 'unsafe' | 'unknown';
    readonly nextAction: 'wait' | 'review' | 'answer' | 'inspect_cleanup' | 'review_checks' | 'resume' | 'none';
    readonly result?: 'success' | 'failed' | 'cancelled' | 'cleanup_failed';
    readonly budgets: ReadonlyArray<{
        readonly scope: 'request' | 'task' | 'goal';
        readonly limit: number | null;
        readonly knownUsed: number | null;
        readonly remaining: number | null;
        readonly complete: boolean;
        readonly inFlight: boolean;
    }>;
}
/** A read-only display projection. It never grants admission, approval or recovery. */
export function projectTaskStatus(f: TaskStatusFacts): TaskStatusSnapshot {
    const now = f.finishedAt ?? f.now ?? Date.now();
    let stage: TaskStage = f.active ? 'model' : 'idle', blocker: TaskStatusSnapshot['blocker'] = null, recovery: TaskStatusSnapshot['recovery'] = 'unknown', nextAction: TaskStatusSnapshot['nextAction'] = f.active ? 'wait' : 'none';
    if (f.active) {
        if (f.mode === 'plan')
            stage = 'planning';
        else if (f.workflow?.phase === 'verify_fast' || f.workflow?.phase === 'verify_full')
            stage = 'verifying';
        else if (f.workflow?.phase === 'diagnose')
            stage = 'repairing';
        else if (f.loopPhase === 'tools')
            stage = 'tools';
    }
    if (!f.active && f.outcome) {
        stage = f.outcome === 'success' ? 'complete' : 'blocked';
        nextAction = f.outcome === 'success' ? 'none' : 'review_checks';
        if(f.outcome==='success')recovery='continue';
        if(f.outcome==='failed'){blocker=f.failure??'runtime';if(f.failure==='environment')recovery='repair_environment';if(f.failure==='persistence')recovery='unsafe';}
    }
    if (f.approval) {
        stage = 'awaiting_approval';
        blocker = 'approval';
        recovery = 'reapprove';
        nextAction = 'review';
    }
    if (f.question) {
        stage = 'awaiting_input';
        blocker = 'input';
        nextAction = 'answer';
    }
    if (f.cancelled && f.active) {
        stage = 'cancelling';
        blocker = 'cleanup';
        recovery = 'unsafe';
        nextAction = 'wait';
    }
    if (!f.active && f.outcome === 'cancelled') {
        stage = 'blocked';
        recovery = 'unknown';
        nextAction = 'resume';
    }
    if (f.workflow?.pending_verification && !f.active) {
        blocker = 'verification';
        recovery = 'reapprove';
        nextAction = 'review_checks';
    }
    if (f.cleanupFailed || f.outcome === 'cleanup_failed') {
        stage = 'blocked';
        blocker = 'cleanup';
        recovery = 'unsafe';
        nextAction = 'inspect_cleanup';
    }
    const budgets = Object.freeze((f.budgets ?? []).map(b => Object.freeze({ scope: b.scope, limit: b.limit, knownUsed: b.used, remaining: b.complete && b.used !== null && b.limit !== null ? Math.max(0, b.limit - b.used) : null, complete: b.complete, inFlight: b.inFlight === true })));
    // A request still in flight is not an accounting failure. Missing settled
    // usage remains unknown, including when the task itself has no token cap.
    if (budgets.some(b => !b.complete && !b.inFlight) && blocker === null && (f.active || f.outcome !== undefined)) {
        blocker = 'usage_unknown';
        if (!f.active) {
            recovery = 'repair_environment';
            nextAction = 'review_checks';
        }
    }
    return Object.freeze({ ...(f.taskId ? { taskId: f.taskId } : {}), ...(f.sessionId ? { sessionId: f.sessionId } : {}), stage, elapsedMs: f.startedAt === undefined ? 0 : Math.max(0, now - f.startedAt), stageElapsedMs: f.stageStartedAt === undefined ? 0 : Math.max(0, now - f.stageStartedAt), ...(f.operation ? { operation: f.operation } : {}), blocker, recovery, nextAction, ...(f.outcome ? { result: f.outcome } : {}), budgets });
}
