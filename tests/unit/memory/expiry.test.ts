import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LearnedMemoryStore, memoryEntryRevision } from "../../../src/memory/learned-memory.js";

test("project Memory expires without recall refreshing it and manual review is revision-bound", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "everpeace-memory-expiry-"));
  let now = new Date("2026-01-01T00:00:00Z");
  const store = new LearnedMemoryStore({ directory: root, now: () => now });
  try {
    await store.append("project", root, [{ lesson: "Use the fixture API", applyWhen: "fixture API", sourceSessionId: "source-session" }]);
    await store.append("user", root, [{ lesson: "Prefer concise output", applyWhen: "all conversations", reviewedAt: now.toISOString() }]);
    const original = (await store.read("project", root))[0]!;
    assert.equal((await store.snapshot(root, "fixture API")).entryIds.includes(original.id), true);
    now = new Date("2026-04-02T00:00:00Z");
    assert.equal((await store.snapshot(root, "fixture API")).entryIds.includes(original.id), false);
    assert.equal((await store.status(root)).needsReview, 1);
    assert.equal(await store.lookup(root, original.id), undefined);
    await store.append("project", root, [{ lesson: original.lesson, applyWhen: original.applyWhen }]);
    assert.equal((await store.read("project", root))[0]!.expiresAt, original.expiresAt);
    await store.reviewEntry("project", root, original.id, memoryEntryRevision(original), "renew");
    const renewed = (await store.read("project", root))[0]!;
    assert.equal((await store.snapshot(root, "fixture API")).entryIds.includes(original.id), true);
    await assert.rejects(store.reviewEntry("project", root, original.id, memoryEntryRevision(original), "disable"), /preview changed/u);
    await store.reviewEntry("project", root, renewed.id, memoryEntryRevision(renewed), "correct", { lesson: "Use the corrected fixture API", applyWhen: "fixture API" });
    const entries = await store.read("project", root);
    assert.equal(entries.find((entry) => entry.id === original.id)?.status, "superseded");
    assert.equal(entries.find((entry) => entry.status === "active")?.supersedes, original.id);
    assert.equal((await store.snapshot(root, "fixture API")).text.includes("concise"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
