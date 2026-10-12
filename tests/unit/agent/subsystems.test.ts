import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentContextRuntime } from "../../../src/agent/context-runtime.js";
import { FileToolRuntime } from "../../../src/agent/file-tool-runtime.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("context ownership commits replacement only after persistence and releases failed compaction", async () => {
  const context = new AgentContextRuntime(); context.append([{ role: "user", content: "original" }]);
  const host = { async compact() { return { output: [{ role: "user", content: "summary" }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }; }, isStaleRule() { return false; }, async persist() { throw new Error("storage fault"); }, async usage() {}, async goalUsage() {}, event: undefined };
  await assert.rejects(context.compact(false, host), /persistence/iu);
  assert.equal(context.history[0]?.content, "original"); assert.equal(context.compacting, false);
  await context.compact(false, { ...host, async persist() {} });
  assert.equal(context.history[0]?.content, "summary"); assert.equal(context.lastCompactedRevision, context.revision);
});
test("file observations are process-local and disposal clears remembered versions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ep-file-state-"));
  try {
    await writeFile(path.join(root, "a.txt"), "one"); const first = new FileToolRuntime(root), restored = new FileToolRuntime(root);
    await first.run("read_file", '{"path":"a.txt"}'); const before = first.observed("a.txt"); assert.equal(typeof before, "string");
    assert.equal(restored.observed("a.txt"), undefined);
    await writeFile(path.join(root, "a.txt"), "two"); await first.run("read_file", '{"path":"a.txt"}'); assert.notEqual(first.observed("a.txt"), before);
    first.dispose(); assert.equal(first.observed("a.txt"), undefined); restored.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});
