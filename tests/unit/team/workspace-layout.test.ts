import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, createTeamWorkspace, removeTeamWorkspace, loadTeamWorkspace, workspaceOperations, validateTeamResume } from "../../../src/team/workspace.js";
import { runApplyPatch } from "../../../src/tools/apply-patch.js";
import { verifyTeamIsolation } from "../../../src/team/isolation.js";
import { defaultPermissions } from "../../../src/permissions/policy.js";
import { windowsNativeSkip } from "../../fixtures/native-mode.js";

test("native subdirectory and linked worktree isolation protects Git and sibling roots", { skip: process.platform === "win32" ? windowsNativeSkip() : false }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ep-layout-native-")));
  let record: Awaited<ReturnType<typeof createTeamWorkspace>> | undefined;
  try {
    const repo = path.join(root, "repo"), linked = path.join(root, "linked"); const nested = path.join("packages", "中文 app");
    await fs.mkdir(path.join(repo, nested), { recursive: true }); await fs.writeFile(path.join(repo, nested, "a.ts"), "export const a = 1;\n");
    await git(repo, ["init"]); await git(repo, ["add", "."]); await git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
    await git(repo, ["worktree", "add", "--detach", linked]);
    const original = await fs.readFile(path.join(repo, ".git", "config"));
    for (const checkout of [repo, linked]) {
      record = await createTeamWorkspace(path.join(checkout, nested));
      await verifyTeamIsolation(record, defaultPermissions());
      await removeTeamWorkspace(record); record = undefined;
    }
    assert.deepEqual(await fs.readFile(path.join(repo, ".git", "config")), original);
    await git(repo, ["worktree", "remove", "--force", linked]);
  } finally { if (record) await removeTeamWorkspace(record); await fs.rm(root, { recursive: true, force: true }); }
});

test("subdirectory snapshots and integration remain within the authorized workspace", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ep-layout-")));
  let record: Awaited<ReturnType<typeof createTeamWorkspace>> | undefined;
  try {
    const source = path.join(root, "packages", "中文 app"); await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "a.ts"), "export const a = 1;\r\n");
    await fs.writeFile(path.join(root, "outside.txt"), "outside the authorization\n");
    await git(root, ["init"]); await git(root, ["add", "."]);
    await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
    const index = await git(root, ["diff", "--cached"]);
    record = await createTeamWorkspace(source);
    assert.equal(record.workspacePrefix, "packages/中文 app");
    assert.deepEqual(Object.keys(record.baseline), ["a.ts"]);
    await assert.rejects(fs.stat(path.join(record.workspaceRoot!, "outside.txt")));
    assert.equal((await loadTeamWorkspace(record.workspace, source)).workspacePrefix, record.workspacePrefix);
    await fs.writeFile(path.join(record.workspace, "a.ts"), "export const a = 2;\r\n");
    const changes = await workspaceOperations(record, ["a.ts"]);
    assert.deepEqual(changes.changedPaths, ["a.ts"]); assert.deepEqual(changes.conflicts, []);
    assert.equal((await runApplyPatch(changes.operations, source)).status, "applied");
    assert.deepEqual(await validateTeamResume(record, ["a.ts"]), []);
    await fs.writeFile(path.join(source, "a.ts"), "concurrent user edit\n");
    assert.deepEqual(await validateTeamResume(record, ["a.ts"]), ["a.ts"]);
    assert.deepEqual((await workspaceOperations(record, ["a.ts"])).conflicts, ["a.ts"]);
    assert.equal(await fs.readFile(path.join(root, "outside.txt"), "utf8"), "outside the authorization\n");
    assert.equal(await git(root, ["diff", "--cached"]), index);
  } finally { if (record) await removeTeamWorkspace(record); await fs.rm(root, { recursive: true, force: true }); }
});

test("linked worktree snapshots preserve the other worktree and common Git metadata", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ep-linked-")));
  let record: Awaited<ReturnType<typeof createTeamWorkspace>> | undefined;
  try {
    const repo = path.join(root, "repo"); const linked = path.join(root, "linked");
    await fs.mkdir(repo); await fs.writeFile(path.join(repo, "a.ts"), "initial\n");
    await git(repo, ["init"]); await git(repo, ["add", "."]); await git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
    await git(repo, ["worktree", "add", "--detach", linked]);
    const config = await fs.readFile(path.join(repo, ".git", "config"));
    await fs.writeFile(path.join(linked, "a.ts"), "dirty linked bytes\n");
    record = await createTeamWorkspace(linked);
    assert.equal(await fs.readFile(path.join(record.workspace, "a.ts"), "utf8"), "dirty linked bytes\n");
    await removeTeamWorkspace(record); record = undefined;
    assert.equal(await fs.readFile(path.join(repo, "a.ts"), "utf8"), "initial\n");
    assert.equal(await fs.readFile(path.join(linked, "a.ts"), "utf8"), "dirty linked bytes\n");
    assert.deepEqual(await fs.readFile(path.join(repo, ".git", "config")), config);
    assert.equal((await git(repo, ["worktree", "list", "--porcelain"])).split("worktree ").length, 3);
    await git(repo, ["worktree", "remove", "--force", linked]);
  } finally { if (record) await removeTeamWorkspace(record); await fs.rm(root, { recursive: true, force: true }); }
});

test("cancelled partial workspace retains ownership and can be explicitly cleaned", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ep-layout-cancel-")));
  let owned: Awaited<ReturnType<typeof createTeamWorkspace>> | undefined;
  try {
    await fs.writeFile(path.join(root, "a.ts"), "initial\n"); await git(root, ["init"]); await git(root, ["add", "."]); await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
    const controller = new AbortController();
    await assert.rejects(createTeamWorkspace(root, controller.signal, async (record) => { owned = record; controller.abort(); }));
    assert.ok(owned); await removeTeamWorkspace(owned); owned = undefined;
    assert.equal(await fs.readFile(path.join(root, "a.ts"), "utf8"), "initial\n");
  } finally { if (owned) await removeTeamWorkspace(owned); await fs.rm(root, { recursive: true, force: true }); }
});
