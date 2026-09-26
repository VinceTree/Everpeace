import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { parseApplyPatchArguments, runApplyPatch } from "../../../src/tools/apply-patch.js";

async function withWorkspace(callback: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-apply-patch-"));
  try { await callback(workspace); } finally { await fs.rm(workspace, { recursive: true, force: true }); }
}

test("apply_patch creates, updates with unified hunks, and deletes files", async () => {
  await withWorkspace(async (workspace) => {
    const created = await runApplyPatch([{ path: "note.txt", action: "create", content: "one\ntwo\n" }], workspace);
    assert.equal(created.status, "applied");
    const updated = await runApplyPatch([{ path: "note.txt", action: "update", patch: "@@ -1,2 +1,2 @@\n one\n-two\n+changed\n" }], workspace);
    assert.equal(updated.status, "applied");
    assert.equal(await fs.readFile(path.join(workspace, "note.txt"), "utf8"), "one\nchanged\n");
    const removed = await runApplyPatch([{ path: "note.txt", action: "delete" }], workspace);
    assert.equal(removed.status, "applied");
    await assert.rejects(fs.access(path.join(workspace, "note.txt")));
  });
});

test("apply_patch rejects traversal, stale hashes, and invalid patch context without writing", async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "file.txt"), "before\n", "utf8");
    const stale = await runApplyPatch([{ path: "file.txt", action: "update", content: "after\n", expectedSha256: createHash("sha256").update("other\n").digest("hex") }], workspace);
    assert.equal(stale.status, "rejected");
    const invalid = await runApplyPatch([{ path: "file.txt", action: "update", patch: "@@ -1,1 +1,1 @@\n-wrong\n+after\n" }], workspace);
    assert.equal(invalid.status, "rejected");
    const traversal = await runApplyPatch([{ path: "../outside.txt", action: "create", content: "nope" }], workspace);
    assert.equal(traversal.status, "rejected");
    assert.equal(await fs.readFile(path.join(workspace, "file.txt"), "utf8"), "before\n");
  });
});

test("apply_patch arguments require bounded, explicit operations", () => {
  assert.deepEqual(parseApplyPatchArguments(JSON.stringify({ operations: [{ path: "x.ts", action: "create", content: "x" }] })), [{ path: "x.ts", action: "create", content: "x" }]);
  assert.throws(() => parseApplyPatchArguments(JSON.stringify({ operations: [{ path: "x.ts", action: "rename" }] })), /action/i);
});
