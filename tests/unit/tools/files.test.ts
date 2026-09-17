import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFileTool } from "../../../src/tools/files.js";

test("file tools read and list within the workspace and reject escapes and unsupported content", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-files-"));
  const root = path.join(parent, "workspace");
  try {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "hello.txt"), "hello");
    await fs.writeFile(path.join(parent, "outside.txt"), "private");
    await fs.writeFile(path.join(root, "binary"), Buffer.from([0, 1]));
    await fs.writeFile(path.join(root, "large"), "x".repeat(131073));
    assert.deepEqual(await runFileTool("read_file", '{"path":"hello.txt"}', root), { path: "hello.txt", content: "hello" });
    const listing = await runFileTool("list_directory", '{"path":"."}', root) as { entries: unknown[] };
    assert.equal(listing.entries.length, 3);
    for (const name of ["../outside.txt", path.join(parent, "outside.txt")]) {
      await assert.rejects(runFileTool("read_file", JSON.stringify({ path: name }), root), /workspace/);
    }
    await fs.symlink(parent, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(runFileTool("read_file", '{"path":"escape/outside.txt"}', root), /workspace/);
    await assert.rejects(runFileTool("read_file", '{"path":"binary"}', root), /Binary/);
    await assert.rejects(runFileTool("read_file", '{"path":"large"}', root), /limit/);
    await assert.rejects(runFileTool("read_file", '{"path":"."}', root));
    await assert.rejects(runFileTool("read_file", '{"path":3}', root), /Invalid/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
