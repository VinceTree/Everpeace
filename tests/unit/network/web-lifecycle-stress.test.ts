import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
test("Web response leases and real sockets return to zero across ten stress batches", { timeout: 120_000 }, async (t) => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", "--import", "tsx", fileURLToPath(new URL("../../fixtures/web-lifecycle-stress.ts", import.meta.url))], { timeout: 115_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  const receipt = JSON.parse(stdout.trim()); assert.equal(receipt.complete, true); assert.equal(receipt.batches.length, 10);
  t.diagnostic(stdout.trim());
});
