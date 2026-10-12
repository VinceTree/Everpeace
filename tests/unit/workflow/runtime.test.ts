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
      return command === `pnpm${process.platform === "win32" ? ".cmd" : ""} run build`
        ? { stdout: "", stderr: "build failed", exitCode: 1, signal: null }
        : successfulBash();
    });
    assert.equal(completed.state.result, "failed");
    assert.equal(completed.state.phase, "diagnose");
    assert.deepEqual(executed, [`pnpm${process.platform === "win32" ? ".cmd" : ""} run typecheck`, `pnpm${process.platform === "win32" ? ".cmd" : ""} run lint`, `pnpm${process.platform === "win32" ? ".cmd" : ""} run test`, `pnpm${process.platform === "win32" ? ".cmd" : ""} run build`]);
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
    assert.deepEqual(commands, [`pnpm${process.platform === "win32" ? ".cmd" : ""} run test`]);
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
    assert.equal(runtime.state.repair_attempts, 0);

    // More patch/check failures in the same model turn do not consume another
    // diagnostic round.
    for (let patch = 1; patch <= 2; patch += 1) {
      const sameTurn: ApplyPatchOperation[] = [{ path: "file.txt", action: "update", content: `same turn ${patch}\n` }];
      await runtime.capturePatch(sameTurn);
      await runtime.afterPatch(sameTurn, await runApplyPatch(sameTurn, workspace), async () => failed);
    }
    assert.equal(runtime.state.repair_attempts, 0);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const repair = await runtime.startRepairTurn();
      assert.equal(repair.repair_attempts, attempt);
      const retryOperations: ApplyPatchOperation[] = [{ path: "file.txt", action: "update", content: `bad ${attempt}\n` }];
      await runtime.capturePatch(retryOperations);
      const retry = await runApplyPatch(retryOperations, workspace);
      await runtime.afterPatch(retryOperations, retry, async () => failed);
      const completed = await runtime.finishTurn(async () => failed);
      assert.equal(completed.state.phase, attempt === 3 ? "blocked" : "diagnose");
    }
    assert.equal(runtime.state.phase, "blocked");
    assert.equal(runtime.state.repair_attempts, 3);
    await assert.rejects(runtime.capturePatch([{ path: "file.txt", action: "update", content: "bypass\n" }]), /blocked/u);
    await assert.rejects(runtime.observeShellExecution(), /blocked/u);
  });
});

test("workflow reruns a passed suite when verification changes tracked contents", async () => {
  await withWorkspace(async (workspace) => {
    await run("git", ["init"], { cwd: workspace });
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
    await fs.writeFile(path.join(workspace, "file.ts"), "before\n", "utf8");
    await run("git", ["add", "package.json", "file.ts"], { cwd: workspace });
    const runtime = new CodingWorkflowRuntime({ workspacePath: workspace });
    await runtime.beginTurn();
    const operations: ApplyPatchOperation[] = [{ path: "file.ts", action: "update", content: "task change\n" }];
    await runtime.capturePatch(operations);
    await runtime.afterPatch(operations, await runApplyPatch(operations, workspace), async () => successfulBash());
    let passes = 0;
    const completed = await runtime.finishTurn(async () => {
      passes += 1;
      await fs.writeFile(path.join(workspace, "file.ts"), `verification change ${passes}\n`, "utf8");
      await fs.writeFile(path.join(workspace, "new.ts"), `generated ${passes}\n`, "utf8");
      return successfulBash();
    });
    assert.equal(passes, 3);
    assert.equal(completed.state.result, "unverified");
    assert.equal(completed.verificationSuite?.stale, true);
    assert.match(completed.state.result_reason ?? "", /changed during final verification/u);
    assert.deepEqual(completed.state.changed_paths, ["file.ts", "new.ts"].sort((left, right) => left.localeCompare(right)));
  });
});

test("workflow accepts the fresh rerun after a one-time verification rewrite", async () => {
  await withWorkspace(async (workspace) => {
    await run("git", ["init"], { cwd: workspace });
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
    await fs.writeFile(path.join(workspace, "file.ts"), "before\n", "utf8");
    await run("git", ["add", "package.json", "file.ts"], { cwd: workspace });
    const runtime = new CodingWorkflowRuntime({ workspacePath: workspace });
    await runtime.beginTurn();
    const operations: ApplyPatchOperation[] = [{ path: "file.ts", action: "update", content: "task change\n" }];
    await runtime.capturePatch(operations);
    await runtime.afterPatch(operations, await runApplyPatch(operations, workspace), async () => successfulBash());
    let passes = 0;
    const completed = await runtime.finishTurn(async () => {
      passes += 1;
      if (passes === 1) await fs.writeFile(path.join(workspace, "generated.ts"), "stable generated file\n", "utf8");
      return successfulBash();
    });
    assert.equal(passes, 2);
    assert.equal(completed.state.result, "verified");
    assert.deepEqual(completed.state.changed_paths, ["file.ts", "generated.ts"].sort((left, right) => left.localeCompare(right)));
  });
});

test("ignored build outputs do not stale a passing verification suite", async () => {
  await withWorkspace(async (workspace) => {
    await run("git", ["init"], { cwd: workspace });
    await fs.writeFile(path.join(workspace, ".gitignore"), "dist/\n", "utf8");
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
    await fs.writeFile(path.join(workspace, "file.ts"), "before\n", "utf8");
    await run("git", ["add", ".gitignore", "package.json", "file.ts"], { cwd: workspace });
    const runtime = new CodingWorkflowRuntime({ workspacePath: workspace });
    await runtime.beginTurn();
    const operations: ApplyPatchOperation[] = [{ path: "file.ts", action: "update", content: "task change\n" }];
    await runtime.capturePatch(operations);
    await runtime.afterPatch(operations, await runApplyPatch(operations, workspace), async () => successfulBash());
    let passes = 0;
    const completed = await runtime.finishTurn(async () => {
      passes += 1;
      await fs.mkdir(path.join(workspace, "dist"), { recursive: true });
      await fs.writeFile(path.join(workspace, "dist", "output.js"), `build ${passes}\n`, "utf8");
      return successfulBash();
    });
    assert.equal(passes, 1);
    assert.equal(completed.state.result, "verified");
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

test("workflow verifies an explicitly patched file even when Git ignores it", async () => {
  await withWorkspace(async (workspace) => {
    await run("git", ["init"], { cwd: workspace });
    await fs.writeFile(path.join(workspace, ".gitignore"), "local.config.js\n", "utf8");
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
    await run("git", ["add", ".gitignore", "package.json"], { cwd: workspace });
    const runtime = new CodingWorkflowRuntime({ workspacePath: workspace });
    await runtime.beginTurn();
    const operations: ApplyPatchOperation[] = [{ path: "local.config.js", action: "create", content: "export default true;\n" }];
    await runtime.capturePatch(operations);
    const applied = await runApplyPatch(operations, workspace);
    await runtime.afterPatch(operations, applied, async () => successfulBash());
    const completed = await runtime.finishTurn(async () => successfulBash());
    assert.equal(completed.state.result, "verified");
    assert.equal(completed.changed, true);
    assert.deepEqual(completed.state.changed_paths, ["local.config.js"]);
  });
});

test("resuming a workflow preserves verification debt and repair exhaustion", async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
    await fs.writeFile(path.join(workspace, "changed.ts"), "export {};\n", "utf8");
    const blocked = new CodingWorkflowRuntime({
      workspacePath: workspace,
      initialState: {
        task_id: "blocked-task",
        task_source: "goal_continuation",
        phase: "blocked",
        repair_attempts: 3,
        max_repair_attempts: 3,
        changed_paths: ["changed.ts"],
        checkpoint_available: false,
        result: "failed",
        pending_verification: true,
        updated_at: new Date().toISOString(),
      },
    });
    await blocked.resumeTurn();
    let checks = 0;
    const completed = await blocked.finishTurn(async () => { checks += 1; return successfulBash(); });
    assert.equal(completed.state.phase, "blocked");
    assert.equal(completed.state.repair_attempts, 3);
    assert.equal(completed.state.result, "failed");
    assert.equal(checks, 0);

    await blocked.beginTurn({ source: "user" });
    assert.deepEqual(blocked.state.prior_unverified, { task_id: "blocked-task", result: "failed" });
  });
});

test("a new no-change task cannot erase a prior unverified result", async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }), "utf8");
    const runtime = new CodingWorkflowRuntime({
      workspacePath: workspace,
      initialState: {
        task_id: "old-task",
        task_source: "user",
        phase: "done",
        repair_attempts: 0,
        max_repair_attempts: 3,
        result: "unverified",
        result_reason: "No checks were available",
        pending_verification: true,
        changed_paths: ["src/old.ts"],
        checkpoint_available: false,
        updated_at: new Date().toISOString(),
      },
    });
    await runtime.beginTurn({ source: "user" });
    const result = await runtime.finishTurn(async () => ({ stdout: "", stderr: "", exitCode: 0, signal: null }));
    assert.equal(result.state.result, "unverified");
    assert.equal(result.state.pending_verification, true);
    assert.equal(result.state.prior_unverified?.task_id, "old-task");
  });
});

test("manual verification stops after cancellation and never runs the next check", async () => {
  await withWorkspace(async (workspace) => {
    await run("git", ["init"], { cwd: workspace });
    const runtime = new CodingWorkflowRuntime({ workspacePath: workspace });
    await runtime.beginTurn();
    const controller = new AbortController();
    const executed: string[] = [];
    await assert.rejects(runtime.runManualVerification([
      { id: "one", label: "one", command: "one", tier: "full", timeoutMs: 1_000 },
      { id: "two", label: "two", command: "two", tier: "full", timeoutMs: 1_000 },
    ], async (command) => {
      executed.push(command);
      controller.abort(new Error("cancelled"));
      return successfulBash();
    }, { supplemental: false, signal: controller.signal }), /cancelled/u);
    assert.deepEqual(executed, ["one"]);
  });
});

test("manual verification becomes unavailable when workspace contents change during the command", async () => {
  await withWorkspace(async (workspace) => {
    await run("git", ["init"], { cwd: workspace });
    await fs.writeFile(path.join(workspace, "tracked.ts"), "before\n", "utf8");
    await run("git", ["add", "tracked.ts"], { cwd: workspace });
    const runtime = new CodingWorkflowRuntime({ workspacePath: workspace });
    await runtime.beginTurn();
    const suite = await runtime.runManualVerification([
      { id: "manual", label: "manual", command: "manual", tier: "full", timeoutMs: 1_000 },
    ], async () => {
      await fs.writeFile(path.join(workspace, "tracked.ts"), "after\n", "utf8");
      return successfulBash();
    }, { supplemental: false });
    assert.equal(suite.status, "unavailable");
    assert.equal(suite.stale, true);
  });
});
