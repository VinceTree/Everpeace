import type { TaskStatusSnapshot } from './task-status.js';
import { uiText, displayStatus, translateHostText } from '../localization/messages.js';
export function formatTaskStatus(snapshot: TaskStatusSnapshot, maxOutputTokens?: number): string[] {
    const lines = [uiText('task.stage', { p0: displayStatus(snapshot.stage), p1: Math.floor(snapshot.elapsedMs / 1000), p2: Math.floor(snapshot.stageElapsedMs / 1000) })];
    if (snapshot.operation)
        lines.push(translateHostText(snapshot.operation));
    if (snapshot.blocker)
        lines.push(uiText('task.blocker', { p0: displayStatus(snapshot.blocker) }));
    lines.push(uiText('task.next', { p0: displayStatus(snapshot.nextAction), p1: displayStatus(snapshot.recovery) }));
    for (const budget of snapshot.budgets)
        lines.push(uiText('task.budget', { p0: displayStatus(budget.scope), p1: budget.limit ?? uiText('task.unlimited'), p2: budget.knownUsed ?? uiText('task.unknown'), p3: budget.remaining ?? uiText('task.unknown'), p4: budget.inFlight ? uiText('task.inflight') : '' }));
    if (maxOutputTokens !== undefined)
        lines.push(uiText('task.output', { p0: maxOutputTokens }));
    return lines;
}
