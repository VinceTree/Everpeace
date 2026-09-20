import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePlanRequest, parseSubmittedPlan } from "../../../src/plan/runtime.js";

test("plan request accepts bounded structured questions", () => {
  const request = parsePlanRequest(JSON.stringify({ questions: [{ id: "storage", header: "Storage", question: "Which storage?", options: [{ label: "JSON", description: "Simple local file" }, { label: "SQLite", description: "Indexed local database" }] }] }));
  assert.equal(request.questions[0]?.id, "storage");
});

test("plan request rejects duplicate ids and invalid option counts", () => {
  assert.throws(() => parsePlanRequest(JSON.stringify({ questions: [{ id: "x", header: "X", question: "X?", options: [{ label: "A", description: "a" }] }] })), /two or three/);
  assert.throws(() => parsePlanRequest(JSON.stringify({ questions: [{ id: "x", header: "X", question: "X?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }, { id: "x", header: "Y", question: "Y?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] })), /unique/);
});

test("submitted plan requires title and body", () => {
  assert.deepEqual(parseSubmittedPlan('{"title":"Plan","plan":"# Steps"}'), { title: "Plan", plan: "# Steps" });
  assert.throws(() => parseSubmittedPlan('{"title":"Plan"}'), /title and Markdown/);
});
