import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatTaskProgress,
  parseTaskProgressArguments,
  taskProgressLimits,
} from "../../../src/workflow/task-progress.js";

test("task progress accepts bounded whole-list replacement and explicit clearing", () => {
  const now = new Date("2026-10-01T00:00:00.000Z");
  const progress = parseTaskProgressArguments(JSON.stringify({
    plan: [
      { step: "Inspect the implementation", status: "completed" },
      { step: "Add the regression", status: "in_progress" },
      { step: "Run checks", status: "pending" },
    ],
  }), now);
  assert.equal(progress.updated_at, now.toISOString());
  assert.deepEqual(progress.plan.map((item) => item.status), ["completed", "in_progress", "pending"]);
  assert.match(formatTaskProgress(progress), /host-persisted/iu);
  assert.deepEqual(parseTaskProgressArguments('{"plan":[]}', now).plan, []);
});

test("task progress rejects duplicates, oversized lists, invalid fields, and several active steps", () => {
  assert.throws(() => parseTaskProgressArguments('{"plan":[{"step":"same","status":"pending"},{"step":"same","status":"completed"}]}'), /unique/iu);
  assert.throws(() => parseTaskProgressArguments('{"plan":[{"step":"one","status":"in_progress"},{"step":"two","status":"in_progress"}]}'), /at most one/iu);
  assert.throws(() => parseTaskProgressArguments('{"plan":[{"step":"x","status":"pending","owner":"model"}]}'), /only step and status/iu);
  assert.throws(() => parseTaskProgressArguments(JSON.stringify({ plan: [{ step: "x".repeat(taskProgressLimits.maxStepCharacters + 1), status: "pending" }] })), /at most 240/iu);
  assert.throws(() => parseTaskProgressArguments(JSON.stringify({ plan: Array.from({ length: taskProgressLimits.maxItems + 1 }, (_, index) => ({ step: `step ${index}`, status: "pending" })) })), /at most 20/iu);
});
