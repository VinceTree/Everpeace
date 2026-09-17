import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { InputHistory } from "../../../src/storage/input-history.js";

test("global history survives reload, serializes writers, deduplicates, and clears", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-history-"));
  try {
    const file = path.join(dir, "history.json");
    const a = new InputHistory(file);
    const b = new InputHistory(file);
    await Promise.all([a.append("first"), b.append("second")]);
    assert.deepEqual(new Set(await new InputHistory(file).load()), new Set(["first", "second"]));
    await a.append("last");
    await b.append("last");
    assert.equal((await a.load()).length, 3);
    await a.clear();
    assert.deepEqual(await b.load(), []);
    await fs.writeFile(file, "broken");
    assert.deepEqual(await a.load(), []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
