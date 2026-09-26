import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { BashResult } from "../../../src/tools/bash.js";
import {
  discoverVerificationCommands,
  runVerificationCommand,
  selectVerificationCommand,
  verificationPrompt,
} from "../../../src/workflow/verifier.js";

async function withWorkspace(callback: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-verifier-"));
  try { await callback(workspace); } finally { await fs.rm(workspace, { recursive: true, force: true }); }
}

test("verification discovery prefers declared and lockfile package managers", async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({
      packageManager: "npm@11.0.0",
      scripts: { typecheck: "tsc", test: "node test.js" },
    }), "utf8");
    await fs.writeFile(path.join(workspace, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");
    const commands = await discoverVerificationCommands(workspace);
    assert.deepEqual(commands.map((command) => command.command), ["npm run typecheck", "npm run test"]);
    assert.equal(selectVerificationCommand(commands, "fast")?.id, "node:typecheck");
    assert.equal(selectVerificationCommand(commands, "full")?.id, "node:test");
  });

  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", build: "tsc" } }), "utf8");
    await fs.writeFile(path.join(workspace, "yarn.lock"), "__metadata:\n", "utf8");
    const commands = await discoverVerificationCommands(workspace);
    assert.deepEqual(commands.map((command) => command.command), ["yarn run lint", "yarn run build"]);
  });
});

test("verification discovery covers conventional Python, Rust, Go, and unknown workspaces", async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "pyproject.toml"), "[tool.pytest.ini_options]\n", "utf8");
    assert.deepEqual((await discoverVerificationCommands(workspace)).map((command) => command.command), ["python -m pytest"]);
  });
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "Cargo.toml"), "[package]\nname='demo'\n", "utf8");
    assert.deepEqual((await discoverVerificationCommands(workspace)).map((command) => command.command), ["cargo check", "cargo test"]);
  });
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "go.mod"), "module demo\n", "utf8");
    assert.deepEqual((await discoverVerificationCommands(workspace)).map((command) => command.command), ["go test ./..."]);
  });
  await withWorkspace(async (workspace) => {
    assert.deepEqual(await discoverVerificationCommands(workspace), []);
  });
});

test("verification results are bounded and produce repair guidance", async () => {
  const command = { id: "test", label: "Test", command: "pnpm test", tier: "full" as const, timeoutMs: 1000 };
  const result: BashResult = {
    stdout: "x".repeat(1_100_000), stderr: "failed", exitCode: 1, signal: null,
  };
  const verification = await runVerificationCommand(command, async () => result);
  assert.equal(verification.passed, false);
  assert.ok(verification.stdout.length <= 1_048_576);
  assert.match(verificationPrompt(verification), /Diagnose the failure/u);
});
