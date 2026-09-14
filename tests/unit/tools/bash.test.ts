import assert from "node:assert/strict";
import { test } from "node:test";
import { runBash } from "../../../src/tools/bash.js";

test("runBash captures stdout and a successful exit code", async () => {
  const result = await runBash("printf hello", { streamOutput: false });

  assert.equal(result.stdout, "hello");
  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
});

test("runBash captures stderr and a non-zero exit code", async () => {
  const result = await runBash("printf problem >&2; exit 7", {
    streamOutput: false,
  });

  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "problem");
  assert.equal(result.exitCode, 7);
});

test("runBash reports a missing executable", async () => {
  const result = await runBash("printf hello", {
    bashPath: "everpeace-definitely-missing-bash",
    streamOutput: false,
  });

  assert.equal(result.exitCode, null);
  assert.match(result.error ?? "", /ENOENT/i);
});

test("runBash can attach directly to the current terminal", async () => {
  const result = await runBash(":", { terminal: true });

  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
});
