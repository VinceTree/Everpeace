import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { BashResult } from "../../../src/tools/bash.js";
import { ProcessCleanupError } from "../../../src/tools/process-completion.js";

import {
  discoverVerificationCommands,
  runVerificationCommand,
  runVerificationSuite,
  selectVerificationCommand,
  selectVerificationCommands,
  verificationPrompt,
} from "../../../src/workflow/verifier.js";

test('conventional diagnostics report missing tools and leave unrecognized failures unknown',async()=>{
 const command={id:'rust:test',label:'Cargo tests',command:'cargo test',tier:'full' as const,timeoutMs:1000};
 const missing=await runVerificationCommand(command,async()=>({exitCode:1,stdout:'',stderr:"'cargo' is not recognized as an internal or external command",signal:null}));
 assert.deepEqual(missing.diagnostic,{category:'environment',missingTool:'cargo'});
 const unknown=await runVerificationCommand(command,async()=>({exitCode:1,stdout:'',stderr:'unrecognized failure',signal:null}));
 assert.deepEqual(unknown.diagnostic,{category:'unknown'});
 const custom=await runVerificationCommand(command,async()=>({exitCode:1,stdout:'',stderr:'unknown_personal_command: command not found',signal:null}));
 assert.deepEqual(custom.diagnostic,{category:'environment'});
});

test("verification cleanup failure escapes the repair loop even with zero exit code", async () => {
  const command = { id: "test", label: "Test", command: "pnpm test", tier: "full" as const, timeoutMs: 1000 };
  let runs = 0;
  await assert.rejects(runVerificationSuite([command, { ...command, id: "build" }], async () => {
    runs++;
    return { stdout: "", stderr: "", exitCode: 0, signal: null, cleanupFailed: true, error: "termination refused" };
  }), ProcessCleanupError);
  assert.equal(runs, 1);
});
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
    assert.deepEqual(commands.map((command) => command.command), [`npm${process.platform === "win32" ? ".cmd" : ""} run typecheck`, `npm${process.platform === "win32" ? ".cmd" : ""} run test`]);
    assert.equal(selectVerificationCommand(commands, "fast")?.id, "node:typecheck");
    assert.equal(selectVerificationCommand(commands, "full")?.id, "node:test");
  });

  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", build: "tsc" } }), "utf8");
    await fs.writeFile(path.join(workspace, "yarn.lock"), "__metadata:\n", "utf8");
    const commands = await discoverVerificationCommands(workspace);
    assert.deepEqual(commands.map((command) => command.command), [`yarn${process.platform === "win32" ? ".cmd" : ""} run lint`, `yarn${process.platform === "win32" ? ".cmd" : ""} run build`]);
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

test("verification passes its command-specific timeout to the executor", async () => {
  const command = { id: "fast", label: "Fast", command: "pnpm typecheck", tier: "fast" as const, timeoutMs: 4321 };
  let received: number | undefined;
  await runVerificationCommand(command, async (_command, _signal, timeoutMs) => {
    received = timeoutMs;
    return { stdout: "", stderr: "", exitCode: 0, signal: null };
  });
  assert.equal(received, 4321);
});

test("full verification runs every Node check in order and stops at the first failure", async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({
      scripts: { build: "build", test: "test", lint: "lint", typecheck: "typecheck" },
    }), "utf8");
    const commands = selectVerificationCommands(await discoverVerificationCommands(workspace), "full");
    assert.deepEqual(commands.map((command) => command.id), ["node:typecheck", "node:lint", "node:test", "node:build"]);
    const executed: string[] = [];
    const suite = await runVerificationSuite(commands, async (command) => {
      executed.push(command);
      return { stdout: "", stderr: "", exitCode: command.endsWith("test") ? 1 : 0, signal: null };
    });
    assert.equal(suite.status, "failed");
    assert.deepEqual(executed, [`pnpm${process.platform === "win32" ? ".cmd" : ""} run typecheck`, `pnpm${process.platform === "win32" ? ".cmd" : ""} run lint`, `pnpm${process.platform === "win32" ? ".cmd" : ""} run test`]);
    assert.deepEqual(suite.skipped.map((command) => command.command), [`pnpm${process.platform === "win32" ? ".cmd" : ""} run build`]);
  });
});

test("empty verification suite is unavailable rather than passed", async () => {
  const suite = await runVerificationSuite([], async () => successfulResult());
  assert.equal(suite.status, "unavailable");
  assert.equal(suite.results.length, 0);
});

test("verification cancellation aborts instead of becoming repair guidance", async () => {
  const command = { id: "test", label: "Test", command: "pnpm test", tier: "full" as const, timeoutMs: 1000 };
  const controller = new AbortController();
  controller.abort(new Error("user cancelled"));
  await assert.rejects(
    runVerificationCommand(command, async () => ({ stdout: "", stderr: "", exitCode: null, signal: null, cancelled: true }), controller.signal),
    /cancelled/u,
  );
});

function successfulResult(): BashResult {
  return { stdout: "", stderr: "", exitCode: 0, signal: null };
}
