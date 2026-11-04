import assert from "node:assert/strict";
import { test } from "node:test";
import { lexicalScores, memoryTerms, rankMemoryEntries, selectMemoryEntries, memoryEntryLine } from "../../../src/memory/retrieval.js";
import { normalizeFact } from "../../../src/memory/facts.js";
import type { LearnedEntry } from "../../../src/memory/learned-memory.js";

const entry = (id: string, lesson: string, scope: "project" | "user" = "project"): LearnedEntry => ({
  id, lesson, scope, applyWhen: "Historical fixture", kind: "summary", confidence: "medium", status: "active",
  createdAt: "2026-11-04T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z",
});

test("candidate plurals share one scoring term while numbers, identifiers, paths and Unicode stay intact", () => {
  assert.deepEqual(memoryTerms("cats stories boxes dishes classes status analysis glass", true), ["cat", "story", "box", "dish", "class", "status", "analysis", "glass"]);
  assert.deepEqual(lexicalScores(["cat", "dogs"], "cat cats", true), lexicalScores(["cat", "dogs"], "cat", true));
  for (const token of ["src/cats.ts", "request_ids", "1234", "猫咪"]) assert.ok(memoryTerms(token, true).includes(token));
  assert.ok(memoryTerms("src/cats.ts", true).includes("cats"));
  assert.deepEqual(memoryTerms("many much", true), []);
  assert.deepEqual(lexicalScores(["catch four", "cat 4"], "cat", true).map(s => s > 0), [false, true]);
  assert.ok(memoryTerms("not allowed", true).includes("not"));
});

const fact = (id: string, session: string, quote = "cat Luna", date = "2026-11-04") => normalizeFact({ id: `fact-${id.padStart(24, "0")}`, lesson: quote, createdAt: date,
  fact: { speaker: "user", quote, sourceId: "message", sourceMessageHash: "a".repeat(64), messageTime: date, sessionId: session } });

test("aggregation discounts only selected same-session facts, preserves updates, and skips oversized rows whole", () => {
  const first = fact("1", "same"), second = fact("2", "same"), other = fact("3", "other");
  assert.deepEqual(selectMemoryEntries([first, second, other], "cat", new Date("2026-11-04"), 8000, "aggregate").map(e => e.id), [first.id, other.id]);
  second.fact.sourceId = "different-message";
  assert.deepEqual(selectMemoryEntries([first, second, other], "cat", new Date("2026-11-04"), 8000, "aggregate").map(e => e.id), [first.id, other.id, second.id]);
  const update = fact("4", "same", "cat Luna", "2026-11-03");
  assert.equal(selectMemoryEntries([first, update], "cat", new Date("2026-11-04"), 8000, "terms").length, 2);
  const changed = fact("5", "same", "cat is not Luna");
  assert.equal(selectMemoryEntries([first, changed], "cat", new Date("2026-11-04"), 8000, "terms").length, 2);
  const huge = fact("6", "same", "cat ".repeat(700));
  const budget = memoryEntryLine(first).length;
  assert.deepEqual(selectMemoryEntries([huge, first], "cat", new Date("2026-11-04"), budget, "aggregate").map(e => e.id), [first.id]);
  assert.deepEqual(selectMemoryEntries([first], "cat", new Date("2026-11-04"), 0), []);
});

test("unknown sessions stay independent and experience and explicit preferences retain fallback", () => {
  const first = fact("1", "one"), second = fact("2", "two");
  delete first.fact.sessionId; delete first.sourceSessionId; delete second.fact.sessionId; delete second.sourceSessionId;
  assert.equal(selectMemoryEntries([first, second], "cat", new Date("2026-11-04"), 8000, "aggregate").length, 2);
  const preference = entry("preference", "Concise answers", "user");
  assert.deepEqual(selectMemoryEntries([entry("unrelated", "Node"), preference], "unknown", new Date("2026-11-04"), 8000, "aggregate").map(e => e.id), [preference.id]);
  assert.equal(selectMemoryEntries([first, preference], "", new Date("2026-11-04"), 8000, "aggregate").length, 2);
});

test("protected aggregation cannot displace counts, prices, attribution, updates or negative evidence", () => {
  const facts = [fact("1", "dungeon", "Mummies (4), not three."), fact("2", "estate", "The vanity can sell for at least $150."),
    fact("3", "dungeon", "The old encounter had three mummies.", "2026-11-03")];
  const preference = entry("user", "Prefer concise answers", "user");
  for (const query of ["how many mummies", "minimum vanity price", "mummies vanity", "", "unmatched"]) {
    for (const budget of [0, 150, 500, 8000]) {
      const eligible = [...facts, preference];
      const before = selectMemoryEntries(eligible, query, new Date("2026-11-04"), budget, "current");
      const after = selectMemoryEntries(eligible, query, new Date("2026-11-04"), budget, "protected");
      assert.deepEqual(after.slice(0, before.length), before);
      assert.ok(after.map(memoryEntryLine).join("\n").length <= budget);
    }
  }
});

test("protected expansion follows bounded shared terms in eligible facts without a topic dictionary", () => {
  const facts = [fact("1", "one", "The quartz almanac subscription arrived."),
    fact("2", "two", "The almanac issue contains a cedar feature."), fact("3", "three", "The cedar feature describes a coastline.")];
  for (let i = 4; i < 40; i++) facts.push(fact(String(i), `unrelated-${i}`, `unrelated_topic_${i}`));
  const baseline = selectMemoryEntries(facts, "quartz", new Date("2026-11-04"), 8000, "current");
  const expanded = selectMemoryEntries(facts, "quartz", new Date("2026-11-04"), 8000, "protected");
  assert.equal(baseline.length, 1);
  assert.deepEqual(expanded.map(f => f.id), facts.slice(0, 3).map(f => f.id));
  assert.equal(selectMemoryEntries(facts.slice(0, 1), "quartz", new Date("2026-11-04"), 8000, "protected").length, 1);
});

test("lexical memory matching preserves names, numbers, paths and Unicode boundaries", () => {
  assert.deepEqual(lexicalScores(["catch four lunatic", "cat 4 Luna"], "cat Luna").map(s => s > 0), [false, true]);
  assert.ok(memoryTerms("４ src/memory/facts.ts request_id").includes("4"));
  assert.ok(memoryTerms("４ src/memory/facts.ts request_id").includes("src/memory/facts.ts"));
  assert.ok(memoryTerms("request_id").includes("request_id"));
  assert.ok(memoryTerms("𠀀木乃伊数量").includes("𠀀木"));
  assert.ok(memoryTerms("𠀀木乃伊数量").includes("乃伊"));
  assert.deepEqual(memoryTerms("the of was our"), []);
  assert.ok(memoryTerms("not allowed").includes("not"));
});

test("rare factual topics outrank unrelated common phrasing without substring inflation", () => {
  const documents = Array.from({ length: 80 }, (_, i) => `The user was thinking of a new topic ${i}, and wants some recommendations.`);
  documents.push("The user makes almond milk creamer with vanilla and honey to save money and reduce sugar.");
  const scores = lexicalScores(documents, "I was thinking of trying a new coffee creamer recipe. Any recommendations?");
  assert.equal(scores.indexOf(Math.max(...scores)), documents.length - 1);
  assert.ok(lexicalScores(["Mummies (4)", "My company will face a new party"], "how many mummies?")[0]! > 0);
});

test("relevance precedes metadata; empty queries and explicit user preferences retain stable fallback", () => {
  const facts = [entry("topic", "cat Luna"), { ...entry("preference", "Use concise answers", "user"), confidence: "high" as const }];
  assert.equal(rankMemoryEntries(facts, "Luna", new Date("2026-11-04"))[0]!.entry.id, "topic");
  assert.deepEqual(rankMemoryEntries(facts, "unrelated", new Date("2026-11-04")).map(x => x.entry.id), ["preference"]);
  assert.equal(rankMemoryEntries(facts, "", new Date("2026-11-04"))[0]!.entry.id, "preference");
  const tied = [entry("a", "same topic"), entry("b", "same topic")];
  assert.deepEqual(rankMemoryEntries(tied, "topic", new Date("2026-11-04")).map(x => x.entry.id), ["a", "b"]);
  assert.deepEqual(lexicalScores([], "topic"), []);
  assert.deepEqual(lexicalScores(["", "the of"], "topic"), [0, 0]);
});
