import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTaskStatus } from '../../../src/status/task-status.js';
test('task display preserves unsafe cleanup, unknown usage and distinct budgets', () => {
    const snapshot = projectTaskStatus({ active: true, cancelled: true, cleanupFailed: true, startedAt: 10, now: 50, budgets: [{ scope: 'goal', limit: 100, used: 30, complete: false }] });
    assert.equal(snapshot.stage, 'blocked');
    assert.equal(snapshot.recovery, 'unsafe');
    assert.equal(snapshot.nextAction, 'inspect_cleanup');
    assert.equal(snapshot.budgets[0]?.remaining, null);
    assert.equal(snapshot.elapsedMs, 40);
    assert.ok(Object.isFrozen(snapshot));
    const approval = projectTaskStatus({ active: true, approval: true });
    assert.equal(approval.stage, 'awaiting_approval');
    assert.equal(approval.nextAction, 'review');
    const done = projectTaskStatus({ active: false, outcome: 'cancelled', startedAt: 10, finishedAt: 40, now: 100 });
    assert.equal(done.elapsedMs, 30);
    assert.equal(done.recovery, 'unknown');
});
test('idle and in-flight accounting do not pretend to block normal operation', () => {
    assert.equal(projectTaskStatus({ active: false, budgets: [{ scope: 'task', limit: null, used: null, complete: false }] }).blocker, null);
    assert.equal(projectTaskStatus({ active: true, budgets: [{ scope: 'task', limit: null, used: null, complete: false }] }).blocker,null);
    const running = projectTaskStatus({ active: true, budgets: [{ scope: 'task', limit: 100, used: 20, complete: false, inFlight: true }] });
    assert.equal(running.blocker, null);
    assert.equal(running.budgets[0]?.remaining, null);
    const settled = projectTaskStatus({ active: false, outcome: 'success', budgets: [{ scope: 'task', limit: 100, used: 20, complete: false }] });
    assert.equal(settled.blocker, 'usage_unknown');
    assert.equal(settled.recovery, 'repair_environment');
});
