import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WorkspaceChangeTracker } from "../../../src/workflow/workspace-tracker.js";

const run = promisify(execFile);

async function withWorkspace(callback: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-tracker-"));
  try { await callback(workspace); } finally { await fs.rm(workspace, { recursive: true, force: true }); }
}

test("workspace tracker distinguishes task changes from an existing dirty baseline", async () => {
  await withWorkspace(async (workspace) => {
    await run("git", ["init"], { cwd: workspace });
    await fs.writeFile(path.join(workspace, "existing dirty.txt"), "before\n", "utf8");
    await run("git", ["add", "existing dirty.txt"], { cwd: workspace });
    await fs.writeFile(path.join(workspace, "existing dirty.txt"), "dirty baseline\n", "utf8");
    const tracker = new WorkspaceChangeTracker(workspace);
    await tracker.begin();

    await fs.writeFile(path.join(workspace, "existing dirty.txt"), "changed in task\n", "utf8");
    await fs.mkdir(path.join(workspace, "新目录"));
    await fs.writeFile(path.join(workspace, "新目录", "文件.ts"), "export {};\n", "utf8");
    const observation = await tracker.observe();
    assert.equal(observation.complete, true);
    assert.deepEqual(observation.changedPaths, ["existing dirty.txt", "新目录/文件.ts"].sort((a, b) => a.localeCompare(b)));

    await fs.writeFile(path.join(workspace, "existing dirty.txt"), "dirty baseline\n", "utf8");
    await fs.rm(path.join(workspace, "新目录"), { recursive: true });
    assert.deepEqual((await tracker.observe()).changedPaths, []);
  });
});

test("workspace tracker reports non-Git workspaces as unavailable", async () => {
  await withWorkspace(async (workspace) => {
    const tracker = new WorkspaceChangeTracker(workspace);
    const baseline = await tracker.begin();
    assert.equal(baseline.available, false);
    await fs.writeFile(path.join(workspace, "file.ts"), "changed\n", "utf8");
    assert.equal((await tracker.observe()).available, false);
  });
});
