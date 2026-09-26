import assert from "node:assert/strict";
import { test } from "node:test";
import { formatWorkspaceInspection, inspectWorkspace } from "../../../src/tools/workspace.js";

test("workspace inspection exposes bounded Git status and optional diff", async () => {
  const inspection = await inspectWorkspace(process.cwd());
  assert.equal(inspection.status, "ok");
  assert.ok(inspection.git);
  const status = JSON.parse(formatWorkspaceInspection(inspection)) as Record<string, unknown>;
  const diff = JSON.parse(formatWorkspaceInspection(inspection, true)) as Record<string, unknown>;
  assert.equal(status.status, "ok");
  assert.equal("diff" in status, false);
  assert.equal(typeof diff.diff, "string");
});

test("workspace inspection reports non-Git directories without throwing", async () => {
  const inspection = await inspectWorkspace("C:\\path\\that\\does\\not\\exist");
  assert.equal(inspection.status, "error");
  assert.match(inspection.error ?? "", /ENOENT|spawn|failed|not a Git/iu);
});
