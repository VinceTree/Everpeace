import assert from "node:assert/strict";
import { test } from "node:test";
import { captureWorkspaceSnapshot } from "../../../src/benchmark/workspace.js";

test("workspace snapshots capture Git identity and bounded status without mutation", async () => {
  const snapshot = await captureWorkspaceSnapshot(process.cwd());

  assert.equal(snapshot.workspacePath, process.cwd());
  assert.equal(snapshot.error, undefined);
  assert.ok(snapshot.git?.root);
  assert.equal(typeof snapshot.git?.status, "string");
  assert.equal(snapshot.git?.head === null || typeof snapshot.git?.head === "string", true);
  assert.equal(snapshot.git?.diffHash === null || typeof snapshot.git?.diffHash === "string", true);
});
