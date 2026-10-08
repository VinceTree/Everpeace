import assert from "node:assert/strict";
import { test } from "node:test";
import { runTask } from "../../../src/sdk/index.js";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

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

test("SDK Plan prints without execution and stops on questions using an isolated local provider", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-sdk-plan-"));
  try {
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "tests/fixtures/sdk-plan-offline.ts"], {
      cwd: process.cwd(), timeout: 30_000,
      env: { ...process.env, EVERPEACE_SDK_TEST_ROOT: root, APPDATA: root, LOCALAPPDATA: root, USERPROFILE: root, HOME: root, CODEX_HOME: path.join(root, "codex"), XDG_CONFIG_HOME: root, XDG_STATE_HOME: root },
    });
    assert.match(result.stdout, /SDK Plan output and question boundaries passed/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("public SDK preserves a stream body cleanup failure and its reliable usage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-sdk-stream-"));
  try {
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "tests/fixtures/sdk-stream-offline.ts"], {
      cwd: process.cwd(), timeout: 30_000,
      env: { ...process.env, EVERPEACE_SDK_TEST_ROOT: root, APPDATA: root, LOCALAPPDATA: root, USERPROFILE: root, HOME: root, CODEX_HOME: path.join(root, "codex"), XDG_CONFIG_HOME: root, XDG_STATE_HOME: root },
    });
    assert.match(result.stdout, /SDK stream cleanup and reliable billing boundaries passed/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
