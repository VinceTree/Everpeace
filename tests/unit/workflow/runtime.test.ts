import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { BashResult } from "../../../src/tools/bash.js";
import { runApplyPatch, type ApplyPatchOperation } from "../../../src/tools/apply-patch.js";
import { CodingWorkflowRuntime } from "../../../src/workflow/runtime.js";

async function withWorkspace(callback: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-runtime-"));
  try { await callback(workspace); } finally { await fs.rm(workspace, { recursive: true, force: true }); }
}

function successfulBash(): BashResult {
  return { stdout: "ok\n", stderr: "", exitCode: 0, signal: null };
}

test("workflow runs fast verification after a patch and full verification at turn end", async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "node test.js" } }), "utf8");
    await fs.writeFile(path.join(workspace, "file.txt"), "before\n", "utf8");
    const states: string[] = [];
    const runtime = new CodingWorkflowRuntime({ workspacePath: workspace, onState: (state) => { states.push(state.phase); } });
    await runtime.beginTurn();
    const operations: ApplyPatchOperation[] = [{ path: "file.txt", action: "update", content: "after\n" }];
    await runtime.capturePatch(operations);
    const applied = await runApplyPatch(operations, workspace);
    const followup = await runtime.afterPatch(operations, applied, async () => successfulBash());
    assert.equal(followup.verification?.passed, true);
    const completed = await runtime.finishTurn(async () => successfulBash());
    assert.equal(completed.state.phase, "done");
    assert.deepEqual(completed.state.changed_paths, ["file.txt"]);
    assert.ok(states.includes("verify_fast"));
    assert.ok(states.includes("verify_full"));
  });
});

test("workflow review runs after full verification and blocks completion on review failure", async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }), "utf8");
    const reviews: string[][] = [];
    const runtime = new CodingWorkflowRuntime({
      workspacePath: workspace,
      review: async (changedPaths) => {
        reviews.push([...changedPaths]);
        return { passed: false, error: "unreviewed change" };
      },
    });
    await runtime.beginTurn();
    const operations: ApplyPatchOperation[] = [{ path: "file.txt", action: "create", content: "change\n" }];
    await runtime.capturePatch(operations);
    const applied = await runApplyPatch(operations, workspace);
    await runtime.afterPatch(operations, applied, async () => successfulBash());
    const completed = await runtime.finishTurn(async () => successfulBash());
    assert.equal(completed.state.phase, "diagnose");
    assert.match(completed.prompt ?? "", /unreviewed change/u);
    assert.deepEqual(reviews, [["file.txt"]]);
  });
});

test("workflow enters diagnosis after a failed verification and bounds repairs", async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }), "utf8");
    const runtime = new CodingWorkflowRuntime({ workspacePath: workspace });
    await runtime.beginTurn();
    const operations: ApplyPatchOperation[] = [{ path: "file.txt", action: "create", content: "bad\n" }];
    await runtime.capturePatch(operations);
    const applied = await runApplyPatch(operations, workspace);
    const failed: BashResult = { stdout: "type error", stderr: "", exitCode: 1, signal: null };
    const followup = await runtime.afterPatch(operations, applied, async () => failed);
    assert.equal(runtime.state.phase, "diagnose");
    assert.match(followup.prompt ?? "", /verify again/u);
    assert.equal(runtime.state.repair_attempts, 1);
  });
});

test("starting a new turn clears the previous in-memory checkpoint", async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }), "utf8");
    const runtime = new CodingWorkflowRuntime({ workspacePath: workspace });
    await runtime.beginTurn();
    const operations: ApplyPatchOperation[] = [{ path: "file.txt", action: "create", content: "first\n" }];
    await runtime.capturePatch(operations);
    const applied = await runApplyPatch(operations, workspace);
    await runtime.afterPatch(operations, applied, async () => successfulBash());
    assert.equal(runtime.checkpointAvailable, true);
    await runtime.beginTurn();
    assert.equal(runtime.checkpointAvailable, false);
    assert.equal((await runtime.undo()).status, "empty");
  });
});
