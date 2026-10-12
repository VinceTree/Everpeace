import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runApplyPatch, type ApplyPatchOperation } from "../../../src/tools/apply-patch.js";
import { TurnCheckpoint } from "../../../src/workflow/checkpoint.js";

async function withWorkspace(callback: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-checkpoint-"));
  try { await callback(workspace); } finally { await fs.rm(workspace, { recursive: true, force: true }); }
}

async function applyAndRecord(checkpoint: TurnCheckpoint, operations: ApplyPatchOperation[], workspace: string) {
  await checkpoint.capture(operations);
  const result = await runApplyPatch(operations, workspace);
  await checkpoint.recordApplied(operations, result);
  return result;
}

test("checkpoint undoes the latest create, update, and delete without persisted snapshots", async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "keep.txt"), "before\n", "utf8");
    const operations: ApplyPatchOperation[] = [
      { path: "keep.txt", action: "update", content: "after\n" },
      { path: "new.txt", action: "create", content: "created\n" },
    ];
    const checkpoint = new TurnCheckpoint(workspace);
    const result = await applyAndRecord(checkpoint, operations, workspace);
    assert.equal(result.status, "applied");
    assert.equal((await checkpoint.undo()).status, "undone");
    assert.equal(await fs.readFile(path.join(workspace, "keep.txt"), "utf8"), "before\n");
    await assert.rejects(fs.access(path.join(workspace, "new.txt")));
    assert.equal(checkpoint.available, false);
  });
});

test("checkpoint refuses to overwrite a file changed after the Agent turn", async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "file.txt"), "before\n", "utf8");
    const operations: ApplyPatchOperation[] = [{ path: "file.txt", action: "update", content: "agent\n" }];
    const checkpoint = new TurnCheckpoint(workspace);
    await applyAndRecord(checkpoint, operations, workspace);
    await fs.writeFile(path.join(workspace, "file.txt"), "user\n", "utf8");
    const undo = await checkpoint.undo();
    assert.equal(undo.status, "conflict");
    assert.deepEqual(undo.restored, []);
    assert.deepEqual(undo.conflicts, ["file.txt"]);
    assert.equal(await fs.readFile(path.join(workspace, "file.txt"), "utf8"), "user\n");
  });
});

test("checkpoint capture rejects paths outside the workspace before reading them", async () => {
  await withWorkspace(async (workspace) => {
    const outside = path.join(path.dirname(workspace), "everpeace-checkpoint-outside.txt");
    await fs.writeFile(outside, "private\n", "utf8");
    try {
      const checkpoint = new TurnCheckpoint(workspace);
      await assert.rejects(
        checkpoint.capture([{ path: "../everpeace-checkpoint-outside.txt", action: "update", content: "nope" }]),
        /outside the current workspace/u,
      );
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
});
