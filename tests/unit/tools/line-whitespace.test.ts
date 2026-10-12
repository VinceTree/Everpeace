import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseApplyPatchArguments, previewApplyPatch, runApplyPatch, type ApplyPatchOperation } from "../../../src/tools/apply-patch.js";

async function fixture(run: (root: string, file: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-whitespace-"));
  try { await run(root, path.join(root, "file.ts")); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
const operation = (oldText: string, newText: string, matchMode?: "exact" | "line_whitespace"): ApplyPatchOperation => ({ path: "file.ts", action: "update", replace: { oldText, newText, ...(matchMode ? { matchMode } : {}) } });

test("long repeated blank-line blocks still locate the unique complete range", async () => {
  await fixture(async (root, file) => {
    await fs.writeFile(file, `${"\t\n".repeat(40_000)}\tvalue\n`);
    const result = await runApplyPatch([operation(`${"\n".repeat(20_000)}  value`, "changed", "line_whitespace")], root);
    assert.equal(result.status, "applied");
    assert.deepEqual(result.files[0]?.matchedLines, { start: 20_001, end: 40_001 });
    assert.equal(await fs.readFile(file, "utf8"), `${"\t\n".repeat(20_000)}changed\n`);
  });
});

test("whitespace matching is opt-in, prefers exact, and preview/execution agree on lines with BOM/CRLF", async () => {
  await fixture(async (root, file) => {
    await fs.writeFile(file, "\ufeffbefore\r\n\tconst value = 1;  \r\n \t\r\n\treturn value;\t\r\nafter\r\n");
    const old = "    const value = 1;\n\n    return value;";
    const next = "const value = 2;\n\nreturn value;";
    assert.equal((await runApplyPatch([operation(old, next)], root)).errorCode, "REPLACEMENT_NOT_FOUND");
    const ops = [operation(old, next, "line_whitespace")];
    const preview = await previewApplyPatch(ops, root);
    assert.equal(preview.status, "ready");
    assert.equal(preview.files[0]?.matchMode, "line_whitespace");
    assert.deepEqual(preview.files[0]?.matchedLines, { start: 2, end: 4 });
    const result = await runApplyPatch(ops, root);
    assert.equal(result.status, "applied");
    assert.deepEqual(result.files[0]?.matchedLines, preview.files[0]?.matchedLines);
    assert.equal(result.files[0]?.matchMode, "line_whitespace");
    assert.equal(await fs.readFile(file, "utf8"), "\ufeffbefore\r\nconst value = 2;\r\n\r\nreturn value;\r\nafter\r\n");
    const exact = await runApplyPatch([operation("value = 2", "value = 3", "line_whitespace")], root);
    assert.equal(exact.files[0]?.matchMode, "exact");
  });
});

test("tolerant blocks require unique complete lines and preserve internal characters and empty-line positions", async () => {
  await fixture(async (root, file) => {
    for (const [source, old, code] of [
      ["same\nsame\n", "same", "REPLACEMENT_AMBIGUOUS"],
      ["\tsame\n  same \n", "    same", "REPLACEMENT_AMBIGUOUS"],
      ["\tprefix value suffix\n", "  value", "REPLACEMENT_NOT_FOUND"],
      ["\tconst x = 'a  b';\n", "const x = 'a b';", "REPLACEMENT_NOT_FOUND"],
      ["\tOne\n", "one", "REPLACEMENT_NOT_FOUND"],
      ["\tone;\n", "one:", "REPLACEMENT_NOT_FOUND"],
      ["\tone\n\n\ttwo\n", "one\ntwo", "REPLACEMENT_NOT_FOUND"],
    ]) {
      await fs.writeFile(file, source!);
      const result = await runApplyPatch([operation(old!, "changed", "line_whitespace")], root);
      assert.equal(result.errorCode, code);
      assert.equal(await fs.readFile(file, "utf8"), source);
    }
    await fs.writeFile(file, "head\n\tone \n\ttwo\nfoot\n");
    assert.equal((await runApplyPatch([operation("  one\n  two\n", "new\n", "line_whitespace")], root)).status, "applied");
    assert.equal(await fs.readFile(file, "utf8"), "head\nnew\nfoot\n");
  });
});

test("invalid modes and whitespace-only targets have no side effects; changed preview bytes remain stale", async () => {
  await fixture(async (root, file) => {
    await fs.writeFile(file, "\tvalue\n");
    for (const replace of [{ oldText: "value", newText: "new", matchMode: "fuzzy" }, ...[" \t\n", "\u00a0", "\u3000", "\f"].map((oldText) => ({ oldText, newText: "new", matchMode: "line_whitespace" }))]) {
      assert.throws(() => parseApplyPatchArguments(JSON.stringify({ operations: [{ path: "file.ts", action: "update", replace }] })), /matchMode|oldText/u);
      assert.equal((await runApplyPatch([{ path: "file.ts", action: "update", replace } as ApplyPatchOperation], root)).errorCode, "INVALID_ARGUMENTS");
    }
    const ops = [operation("  value", "new", "line_whitespace")];
    const preview = await previewApplyPatch(ops, root);
    assert.equal(preview.status, "ready");
    await fs.writeFile(file, "user concurrent edit\n");
    const result = await runApplyPatch([{ ...ops[0]!, expectedSha256: preview.files[0]!.beforeSha256! }], root);
    assert.equal(result.errorCode, "STALE_VERSION");
    assert.equal(await fs.readFile(file, "utf8"), "user concurrent edit\n");
    assert.notEqual(createHash("sha256").update(await fs.readFile(file)).digest("hex"), preview.files[0]?.afterSha256);
  });
});

test("a failed batch never rolls a whitespace edit back over a concurrent user change", async (context) => {
  await fixture(async (root, file) => {
    const alias = path.join(root, "workspace-alias");
    await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    const second = path.join(alias, "second.ts");
    await fs.writeFile(file, "\tvalue\n");
    await fs.writeFile(second, "before\n");
    try {
      const result = await runApplyPatch([operation("  value", "new", "line_whitespace"), { path: "second.ts", action: "update", content: "after\n" }], root, { async beforeCommit(relative) {
        if (relative === 'second.ts') { await fs.writeFile(file, 'user edit\n'); throw new Error('fixture second write failure'); }
      } });
      assert.equal(result.status, "failed");
      assert.equal(result.rolledBack, false);
      assert.deepEqual(result.rollbackConflicts, ["file.ts"]);
      assert.equal(await fs.readFile(file, "utf8"), "user edit\n");
      assert.equal(await fs.readFile(second, "utf8"), "before\n");
    } finally { context.mock.restoreAll(); }
  });
});
