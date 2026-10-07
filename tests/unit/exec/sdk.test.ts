import assert from "node:assert/strict";
import { test } from "node:test";
import { runTask } from "../../../src/sdk/index.js";

test("runTask defaults the workspace and reaches a clean configuration error without credentials", async () => {
  const registry = {
    async resolveAll() {
      return { available: [], missing: [] };
    },
  };
  const result = await runTask({
    prompt: "work",
    workspacePath: process.cwd(),
    registry,
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.classification, "configuration_error");
});

test("runTask rejects a blank prompt before touching the registry", async () => {
  let resolved = false;
  const registry = {
    async resolveAll() {
      resolved = true;
      return { available: [], missing: [] };
    },
  };
  const result = await runTask({ prompt: "   ", registry });
  assert.equal(result.exitCode, 2);
  assert.equal(resolved, false);
});