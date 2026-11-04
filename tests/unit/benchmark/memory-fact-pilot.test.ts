import assert from "node:assert/strict";
import { test } from "node:test";
import { selectFactPilot, skippedPilotKeys } from "../../../src/benchmark/memory-fact-pilot.js";
import { QUESTION_TYPES, type MemoryQuestion } from "../../../src/benchmark/memory-data.js";

test("the small pilot stays inside development, preserves anchors and freezes two questions per category", () => {
  const dev: MemoryQuestion[] = QUESTION_TYPES.flatMap((type, category) => Array.from({ length: 10 }, (_, i) => ({ id: `${category}-${i}`,
    type, history: [], historyHash: `${category}-${i}`, question: "fixture", date: "2026-01-01" })));
  dev[0]!.id = "0862e8bf"; dev[10]!.id = "16c90bf4"; dev[11]!.id = "18dcd5a5";
  const selected = selectFactPilot(dev);
  assert.equal(selected.length, 12);
  assert.equal(new Set(selected.map(q => q.id)).size, 12);
  assert.ok(["0862e8bf", "16c90bf4", "18dcd5a5"].every(id => selected.some(q => q.id === id)));
  for (const type of QUESTION_TYPES) assert.equal(selected.filter(q => q.type === type).length, 2);
  assert.deepEqual(selectFactPilot([...dev].reverse()), selected);
});

test("insufficient development categories cannot silently borrow from the holdout", () => {
  assert.throws(() => selectFactPilot([]), /two questions per type/u);
});

test("pilot continuation selects only skipped identities, never closed failures or completed answers", () => {
  const planned = ["a", "b", "c"].map(key => ({ key, questionId: key, arm: "fact-memory" as const }));
  const rows = planned.map((p, i) => ({ ...p, status: ["completed", "failed", "skipped"][i] as "completed" | "failed" | "skipped", correct: null }));
  assert.deepEqual(skippedPilotKeys(planned, rows), ["c"]);
  assert.throws(() => skippedPilotKeys(planned, rows.slice(0, 2)), /coverage/u);
  assert.throws(() => skippedPilotKeys(planned, [...rows.slice(0, 2), { ...rows[2]!, questionId: "other" }]), /identity/u);
});
