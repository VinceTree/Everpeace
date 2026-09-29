import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { BashResult } from "../../../src/tools/bash.js";
import { runApplyPatch, type ApplyPatchOperation } from "../../../src/tools/apply-patch.js";
import { CodingWorkflowRuntime } from "../../../src/workflow/runtime.js";

const run = promisify(execFile);

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

test("workflow requires the complete Node verification suite before completion", async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({
      scripts: { typecheck: "tsc", lint: "eslint .", test: "node test.js", build: "tsc -p tsconfig.build.json" },
    }), "utf8");
    const runtime = new CodingWorkflowRuntime({ workspacePath: workspace });
    await runtime.beginTurn();
    const operations: ApplyPatchOperation[] = [{ path: "file.ts", action: "create", content: "export {};\n" }];
    await runtime.capturePatch(operations);
    const applied = await runApplyPatch(operations, workspace);
    await runtime.afterPatch(operations, applied, async () => successfulBash());
    const executed: string[] = [];
    const completed = await runtime.finishTurn(async (command) => {
      executed.push(command);
      return command === "pnpm run build"
        ? { stdout: "", stderr: "build failed", exitCode: 1, signal: null }
        : successfulBash();
    });
    assert.equal(completed.state.result, "failed");
    assert.equal(completed.state.phase, "diagnose");
    assert.deepEqual(executed, ["pnpm run typecheck", "pnpm run lint", "pnpm run test", "pnpm run build"]);
    assert.equal(completed.verificationSuite?.status, "failed");
  });
});

test("workflow re-discovers checks created during the current turn", async () => {
  await withWorkspace(async (workspace) => {
    const runtime = new CodingWorkflowRuntime({ workspacePath: workspace });
    await runtime.beginTurn();
    const operations: ApplyPatchOperation[] = [{
      path: "package.json",
      action: "create",
      content: JSON.stringify({ scripts: { test: "node --test" } }),
    }];
    await runtime.capturePatch(operations);
    const applied = await runApplyPatch(operations, workspace);
    await runtime.afterPatch(operations, applied, async () => successfulBash());
    const commands: string[] = [];
    const completed = await runtime.finishTurn(async (command) => { commands.push(command); return successfulBash(); });
    assert.deepEqual(commands, ["pnpm run test"]);
    assert.equal(completed.state.result, "verified");
  });
});

test("workflow marks changed projects without checks as unverified", async () => {
  await withWorkspace(async (workspace) => {
    const runtime = new CodingWorkflowRuntime({ workspacePath: workspace });
    await runtime.beginTurn();
    const operations: ApplyPatchOperation[] = [{ path: "file.txt", action: "create", content: "change\n" }];
    await runtime.capturePatch(operations);
    const applied = await runApplyPatch(operations, workspace);
    await runtime.afterPatch(operations, applied, async () => successfulBash());
    const completed = await runtime.finishTurn(async () => successfulBash());
    assert.equal(completed.verificationSuite?.status, "unavailable");
    assert.equal(completed.state.result, "unverified");
    assert.equal(completed.state.phase, "done");
  });
});

test("workflow observes shell changes to clean, dirty, and untracked Git files", async () => {
  await withWorkspace(async (workspace) => {
    await run("git", ["init"], { cwd: workspace });
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
    await fs.writeFile(path.join(workspace, "dirty.ts"), "staged\n", "utf8");
    await run("git", ["add", "package.json", "dirty.ts"], { cwd: workspace });
    await fs.writeFile(path.join(workspace, "dirty.ts"), "dirty baseline\n", "utf8");
    const runtime = new CodingWorkflowRuntime({ workspacePath: workspace });
    await runtime.beginTurn();
    await fs.writeFile(path.join(workspace, "dirty.ts"), "shell changed\n", "utf8");
    await fs.writeFile(path.join(workspace, "新文件.ts"), "export {};\n", "utf8");
    await runtime.observeShellExecution();
    const completed = await runtime.finishTurn(async () => successfulBash());
    assert.equal(completed.state.result, "verified");
    assert.deepEqual(completed.state.changed_paths, ["dirty.ts", "新文件.ts"].sort((a, b) => a.localeCompare(b)));
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

test("workflow cancellation does not become a repair attempt", async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }), "utf8");
    const controller = new AbortController();
    const runtime = new CodingWorkflowRuntime({
      workspacePath: workspace,
      review: async () => {
        controller.abort(new Error("review cancelled"));
        throw controller.signal.reason;
      },
    });
    await runtime.beginTurn();
    const operations: ApplyPatchOperation[] = [{ path: "file.txt", action: "create", content: "change\n" }];
    await runtime.capturePatch(operations);
    const applied = await runApplyPatch(operations, workspace);
    await runtime.afterPatch(operations, applied, async () => successfulBash());
    await assert.rejects(runtime.finishTurn(async () => successfulBash(), controller.signal), /cancelled/u);
    assert.equal(runtime.state.phase, "review");
    assert.equal(runtime.state.repair_attempts, 0);
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

    for (let attempt = 2; attempt <= 4; attempt += 1) {
      await runtime.startRepairTurn();
      const retryOperations: ApplyPatchOperation[] = [{ path: "file.txt", action: "update", content: `bad ${attempt}\n` }];
      await runtime.capturePatch(retryOperations);
      const retry = await runApplyPatch(retryOperations, workspace);
      await runtime.afterPatch(retryOperations, retry, async () => failed);
    }
    assert.equal(runtime.state.phase, "blocked");
    assert.equal(runtime.state.repair_attempts, 3);
    await assert.rejects(runtime.capturePatch([{ path: "file.txt", action: "update", content: "bypass\n" }]), /blocked/u);
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
