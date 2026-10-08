import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeSessionTitle } from "../../../src/tui/app/dependencies.js";
import { textWidth } from "../../../src/tui/rendering/text-width.js";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

test("session titles are single-line, plain text, and width limited", () => {
  assert.equal(sanitizeSessionTitle("# “修复终端缩放问题！”\nextra"), "修复终端缩放问题");
  assert.equal(sanitizeSessionTitle("**Investigate flaky tests.**"), "Investigate flaky tests");
  assert.ok(textWidth(sanitizeSessionTitle("会".repeat(40))) <= 60);
});

test("independent production auxiliary operations retain known usage after an earlier gap", async () => {
  const root = await mkdtemp(join(tmpdir(), "everpeace-tui-auxiliary-"));
  try {
    const result = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("tests/fixtures/tui-auxiliary-offline.ts")], {
      cwd: root, timeout: 30_000,
      env: { ...process.env, EVERPEACE_AUXILIARY_TEST_ROOT: root, APPDATA: root, LOCALAPPDATA: root, USERPROFILE: root, HOME: root, CODEX_HOME: join(root, "codex"), XDG_CONFIG_HOME: root, XDG_STATE_HOME: root },
    });
    assert.match(result.stdout, /TUI auxiliary request scopes and sticky usage passed/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("production TUI disposal owns manual Memory persistence without starting background capture", async (t) => {
  for (const failure of ["cancel", "storage"] as const) await t.test(failure, async () => {
    const root = await mkdtemp(join(tmpdir(), "everpeace-tui-memory-lifecycle-"));
    try {
      const result = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("tests/fixtures/tui-memory-lifecycle.ts")], {
        cwd: root, timeout: 30_000,
        env: { ...process.env, EVERPEACE_MEMORY_TEST_ROOT: root, EVERPEACE_MEMORY_TEST_FAILURE: failure, APPDATA: root, LOCALAPPDATA: root, USERPROFILE: root, HOME: root, CODEX_HOME: join(root, "codex"), XDG_CONFIG_HOME: root, XDG_STATE_HOME: root },
      });
      assert.match(result.stdout, /TUI manual Memory disposal and queue isolation passed/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
