import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ApplyPatchError, parseApplyPatchArguments, previewApplyPatch, runApplyPatch } from "../../../src/tools/apply-patch.js";

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

test("apply_patch accepts a workspace reached through a filesystem alias", async (context) => {
  if (process.platform === "win32") { context.skip("Windows temporary-directory aliases are covered by the clean-checkout CI"); return; }
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-apply-patch-alias-"));
  const workspace = path.join(parent, "workspace");
  const alias = path.join(parent, "alias");
  try {
    await fs.mkdir(workspace);
    await fs.symlink(workspace, alias, "dir");
    const result = await runApplyPatch([{ path: "note.txt", action: "create", content: "safe\n" }], alias);
    assert.equal(result.status, "applied", result.error);
    assert.equal(await fs.readFile(path.join(workspace, "note.txt"), "utf8"), "safe\n");
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
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

test("apply_patch preview validates and shows changes without mutating files", async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "file.txt"), "before\n", "utf8");
    const preview = await previewApplyPatch([{ path: "file.txt", action: "update", content: "after\n" }], workspace);
    assert.equal(preview.status, "ready");
    assert.match(preview.diff, /-before/u);
    assert.match(preview.diff, /\+after/u);
    assert.equal(await fs.readFile(path.join(workspace, "file.txt"), "utf8"), "before\n");
  });
});

test("patch preview and execution protect control metadata and reject the whole batch", async () => {
  await withWorkspace(async (workspace) => {
    for (const directory of [".git", ".codex", ".agents", ".everpeace"]) {
      await fs.mkdir(path.join(workspace, directory));
      const operations = [
        { path: "ordinary.txt", action: "create" as const, content: "allowed" },
        { path: `${directory}/settings`, action: "create" as const, content: "untrusted override" },
      ];
      assert.equal((await previewApplyPatch(operations, workspace)).status, "rejected");
      assert.equal((await runApplyPatch(operations, workspace)).status, "rejected");
      await assert.rejects(fs.access(path.join(workspace, "ordinary.txt")));
      const fullAccess = await runApplyPatch([operations[1]!], workspace, { allowProtectedPaths: true });
      assert.equal(fullAccess.status, "applied");
    }
    assert.equal((await runApplyPatch([{ path: "normal.txt:stream", action: "create", content: "hidden" }], workspace, { allowProtectedPaths: true })).status, "rejected");
  });
});

test("apply_patch accepts raw-byte observations and preserves BOM plus CRLF", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "bom.txt");
    const before = Buffer.from("\ufeffone\r\ntwo\r\n", "utf8");
    await fs.writeFile(target, before);
    const expectedSha256 = createHash("sha256").update(before).digest("hex");
    const updated = await runApplyPatch([{
      path: "bom.txt",
      action: "update",
      expectedSha256,
      patch: "@@ -1,2 +1,2 @@\n one\n-two\n+changed\n",
    }], workspace);
    assert.equal(updated.status, "applied");
    assert.deepEqual(await fs.readFile(target), Buffer.from("\ufeffone\r\nchanged\r\n", "utf8"));
    const stale = await runApplyPatch([{ path: "bom.txt", action: "delete", expectedSha256 }], workspace);
    assert.equal(stale.status, "rejected");
  });
});

test("apply_patch performs one exact replacement while preserving BOM and CRLF", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "replace.txt");
    await fs.writeFile(target, Buffer.from("\ufeffbefore\r\nunique value\r\nafter\r\n", "utf8"));
    const result = await runApplyPatch([{
      path: "replace.txt",
      action: "update",
      replace: { oldText: "before\nunique value\nafter", newText: "before\nchanged value\nafter" },
    }], workspace);
    assert.equal(result.status, "applied");
    assert.deepEqual(await fs.readFile(target), Buffer.from("\ufeffbefore\r\nchanged value\r\nafter\r\n", "utf8"));
  });
});

test("apply_patch rejects missing, ambiguous, and unchanged replacements with stable codes", async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "replace.txt"), "same same\n", "utf8");
    const missing = await runApplyPatch([{ path: "replace.txt", action: "update", replace: { oldText: "absent", newText: "value" } }], workspace);
    assert.equal(missing.errorCode, "REPLACEMENT_NOT_FOUND");
    assert.match(missing.remedy ?? "", /Read the current file/u);

    const ambiguous = await runApplyPatch([{ path: "replace.txt", action: "update", replace: { oldText: "same", newText: "value" } }], workspace);
    assert.equal(ambiguous.errorCode, "REPLACEMENT_AMBIGUOUS");

    const unchanged = await runApplyPatch([{ path: "replace.txt", action: "update", replace: { oldText: "same same", newText: "same same" } }], workspace);
    assert.equal(unchanged.errorCode, "REPLACEMENT_UNCHANGED");
  });
});

test("apply_patch replacement is mutually exclusive with content and patch", async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "replace.txt"), "old\n", "utf8");
    const result = await runApplyPatch([{
      path: "replace.txt",
      action: "update",
      content: "new\n",
      replace: { oldText: "old", newText: "new" },
    }], workspace);
    assert.equal(result.status, "rejected");
    assert.equal(result.errorCode, "INVALID_ARGUMENTS");
  });
});

test("apply_patch parsing rejects unsupported top-level fields with a stable code", () => {
  assert.throws(
    () => parseApplyPatchArguments('{"operations":[{"path":"x.txt","action":"create","content":"x"}],"alternate":true}'),
    (error: unknown) => error instanceof ApplyPatchError && error.code === "INVALID_ARGUMENTS",
  );
});
