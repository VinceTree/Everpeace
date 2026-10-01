import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { listWorkspaceChanges, readWorkspaceChange } from "../../../src/tools/workspace-review.js";
import { WorkspaceReviewSession } from "../../../src/tools/workspace.js";

const exec = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd: root, windowsHide: true });
}

test("workspace review separates overlapping staged, unstaged, and untracked changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-review-"));
  try {
    await git(root, "init");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test");
    await fs.writeFile(path.join(root, "tracked.txt"), "base\n", "utf8");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "-m", "initial");
    await fs.writeFile(path.join(root, "tracked.txt"), "staged\n", "utf8");
    await git(root, "add", "tracked.txt");
    await fs.writeFile(path.join(root, "tracked.txt"), "unstaged\n", "utf8");
    await fs.writeFile(path.join(root, "new file.txt"), "untracked preview\n", "utf8");

    const index = await listWorkspaceChanges(root);
    assert.deepEqual(index.entries.map(({ kind, path: filePath }) => [kind, filePath]), [
      ["staged", "tracked.txt"],
      ["unstaged", "tracked.txt"],
      ["untracked", "new file.txt"],
    ]);
    const staged = await readWorkspaceChange(root, index.entries[0]!);
    const unstaged = await readWorkspaceChange(root, index.entries[1]!);
    const untracked = await readWorkspaceChange(root, index.entries[2]!);
    assert.equal(staged.contentKind, "diff");
    assert.match(staged.text, /\+staged/u);
    assert.match(unstaged.text, /\+unstaged/u);
    assert.deepEqual({ kind: untracked.contentKind, text: untracked.text }, { kind: "text", text: "untracked preview\n" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workspace review resolves untracked previews from the canonical workspace root", async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-review-canonical-"));
  try {
    const root = path.join(parent, "repository");
    const alias = path.join(parent, "workspace-alias");
    await fs.mkdir(root);
    await git(root, "init");
    await fs.writeFile(path.join(root, "new file.txt"), "canonical preview\n", "utf8");
    try {
      await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    } catch {
      context.skip("This platform does not permit a temporary workspace alias.");
      return;
    }

    const entry = (await listWorkspaceChanges(alias)).entries.find((candidate) => candidate.path === "new file.txt");
    assert.ok(entry);
    const detail = await readWorkspaceChange(alias, entry);
    assert.deepEqual({ kind: detail.contentKind, text: detail.text }, { kind: "text", text: "canonical preview\n" });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("workspace review scopes nested workspaces and summarizes binary and symbolic-link files", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-review-kinds-"));
  try {
    await git(root, "init");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test");
    await fs.mkdir(path.join(root, "nested"));
    await fs.writeFile(path.join(root, "outside.txt"), "outside\n", "utf8");
    await fs.writeFile(path.join(root, "nested", "binary.dat"), Buffer.from([0, 1, 2]));
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial");
    await fs.writeFile(path.join(root, "outside.txt"), "changed outside\n", "utf8");
    await fs.writeFile(path.join(root, "nested", "binary.dat"), Buffer.from([0, 9, 2]));
    if (process.platform !== "win32") {
      await fs.symlink("binary.dat", path.join(root, "nested", "link"));
    } else {
      context.diagnostic("Windows developer mode may be required for symlink creation; tracked binary coverage remains active.");
    }

    const index = await listWorkspaceChanges(path.join(root, "nested"));
    assert.ok(index.entries.every((entry) => !entry.path.includes("outside.txt")));
    const binary = index.entries.find((entry) => entry.path === "binary.dat");
    assert.ok(binary);
    const detail = await readWorkspaceChange(path.join(root, "nested"), binary);
    assert.equal(detail.contentKind, "summary");
    assert.match(detail.text, /Binary file change/u);
    const link = index.entries.find((entry) => entry.path === "link");
    if (link) assert.match((await readWorkspaceChange(path.join(root, "nested"), link)).text, /symbolic link/iu);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workspace review handles unborn repositories, renames, deletions, and fresh concurrent details", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-review-history-"));
  try {
    await git(root, "init");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test");
    await fs.writeFile(path.join(root, "初始 file.txt"), "unborn\n", "utf8");
    await git(root, "add", "初始 file.txt");
    const unborn = await listWorkspaceChanges(root);
    const unbornEntry = unborn.entries.find((entry) => entry.path === "初始 file.txt");
    assert.ok(unbornEntry);
    assert.match((await readWorkspaceChange(root, unbornEntry)).text, /\+unborn/u);

    await git(root, "commit", "-m", "initial");
    await fs.writeFile(path.join(root, "delete me.txt"), "remove me\n", "utf8");
    await fs.writeFile(path.join(root, "concurrent.txt"), "base\n", "utf8");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "tracked files");
    await git(root, "mv", "初始 file.txt", "renamed ü.txt");
    await fs.rm(path.join(root, "delete me.txt"));
    await fs.writeFile(path.join(root, "concurrent.txt"), "first change\n", "utf8");

    const index = await listWorkspaceChanges(root);
    const renamed = index.entries.find((entry) => entry.path === "renamed ü.txt");
    const deleted = index.entries.find((entry) => entry.path === "delete me.txt");
    const concurrent = index.entries.find((entry) => entry.path === "concurrent.txt");
    assert.ok(renamed);
    assert.equal(renamed.oldPath, "初始 file.txt");
    assert.ok(deleted);
    assert.ok(concurrent);
    const renameDetail = await readWorkspaceChange(root, renamed);
    assert.match(renameDetail.text, /-unborn/u);
    assert.match(renameDetail.text, /\+unborn/u);
    assert.match((await readWorkspaceChange(root, deleted)).text, /-remove me/u);

    await fs.writeFile(path.join(root, "concurrent.txt"), "latest change\n", "utf8");
    assert.match((await readWorkspaceChange(root, concurrent)).text, /\+latest change/u);
    await assert.rejects(
      readWorkspaceChange(root, { ...concurrent, path: "../outside.txt" }),
      /escapes the active workspace/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workspace review marks line-bounded tracked detail as truncated", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-review-truncated-"));
  try {
    await git(root, "init");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test");
    const filePath = path.join(root, "many-lines.txt");
    await fs.writeFile(filePath, Array.from({ length: 10_100 }, (_, index) => `old ${index}\n`).join(""), "utf8");
    await git(root, "add", "many-lines.txt");
    await git(root, "commit", "-m", "many lines");
    await fs.writeFile(filePath, Array.from({ length: 10_100 }, (_, index) => `new ${index}\n`).join(""), "utf8");
    const entry = (await listWorkspaceChanges(root)).entries[0];
    assert.ok(entry);
    const detail = await readWorkspaceChange(root, entry);
    assert.equal(detail.truncated, true);
    assert.match(detail.warning ?? "", /10,000 lines/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("model workspace review keeps opaque references bound to a captured index", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-review-session-"));
  try {
    await git(root, "init");
    await fs.writeFile(path.join(root, "new file.txt"), "preview\n", "utf8");
    const session = new WorkspaceReviewSession(root);
    const page = await session.list("{}");
    assert.equal(page.status, "ok");
    assert.equal(page.total, 1);
    const entry = (page.entries as Array<{ reference: string }>)[0];
    assert.ok(entry?.reference);
    const detail = await session.read(JSON.stringify({ reference: entry.reference }));
    assert.equal(detail.contentKind, "text");
    assert.equal(detail.text, "preview\n");
    session.clear();
    await assert.rejects(session.read(JSON.stringify({ reference: entry.reference })), /unknown or expired/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
