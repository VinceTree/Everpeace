import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../../../src/storage/session-store.js";

const fixtureFile = fileURLToPath(new URL("../../fixtures/exec-process.ts", import.meta.url));

async function fixture(scenario: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-exec-process-"));
  const child = spawn(process.execPath, ["--import", "tsx", fixtureFile, directory, scenario], { stdio: ["pipe", "pipe", "pipe", "ipc"] }) as ChildProcessWithoutNullStreams;
  child.stdin.end();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  if (scenario !== "stderr-stall") child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  const ready = new Promise<void>((resolve, reject) => {
    child.once("message", () => resolve());
    child.once("exit", () => reject(new Error(`Exec fixture exited before provider readiness: ${stderr}`)));
  });
  void ready.catch(() => {});
  const stdoutEnd = new Promise<void>((resolve) => { child.stdout.once("end", resolve); child.stdout.once("close", resolve); });
  const timeout = setTimeout(() => child.kill(), 15_000);
  return {
    child, directory, exit, ready, stdoutEnd, stderr: () => stderr,
    async disposed() {
      const marker = JSON.parse(await fs.readFile(path.join(directory, "disposed.json"), "utf8")) as { calls: number; helperPid: number };
      assert.equal(marker.calls, 1);
      assert.throws(() => process.kill(marker.helperPid, 0), "owned helper process was cleaned up");
    },
    async cleanup() {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exit; }
      child.stdout.destroy();
      child.stderr.destroy();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

test("real exec process preserves a large answer under slow reads and persists a resumable Session before final", { timeout: 20_000 }, async () => {
  const f = await fixture("slow");
  try {
    const chunks: Buffer[] = [];
    let finalAfterDispose = false;
    f.child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (chunk.toString("utf8").includes('"type":"run_finished"')) {
        finalAfterDispose = existsSync(path.join(f.directory, "disposed.json"));
      }
      f.child.stdout.pause();
      setTimeout(() => f.child.stdout.resume(), 1);
    });
    const [code] = await f.exit;
    await f.stdoutEnd;
    assert.equal(code, 0, f.stderr());
    const output = Buffer.concat(chunks).toString("utf8");
    const records = output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const answer = records.find((record) => record.type === "assistant_message")?.text;
    assert.equal(answer, `${"正文😀\\\"\r\n".repeat(80_000)}Authorization: Bearer [secret redacted]\nEND`);
    assert.equal(records.at(-1)?.type, "run_finished");
    assert.equal(records.filter((record) => record.type === "run_finished").length, 1);
    assert.equal(finalAfterDispose, true);
    assert.equal(output.includes("abcdefghijklmnop"), false);
    await f.disposed();
    const store = new SessionStore({ directory: path.join(f.directory, "sessions") });
    const restored = await store.load(String(records.at(-1)?.session_id));
    assert.ok(restored.timeline.some((entry) => "text" in entry && entry.text === answer));
  } finally { await f.cleanup(); }
});

test("real stderr close and no-progress failures also cancel and dispose the task", { timeout: 35_000 }, async (t) => {
  for (const scenario of ["stderr-closed", "stderr-stall"]) {
    await t.test(scenario, async () => {
      const f = await fixture(scenario);
      try {
        f.child.stdout.resume();
        if (scenario === "stderr-closed") f.child.stderr.once("data", () => f.child.stderr.destroy());
        const [code] = await f.exit;
        assert.equal(code, 1);
        await f.disposed();
        const terminal = JSON.parse(await fs.readFile(path.join(f.directory, "exit.json"), "utf8")) as { code: number };
        assert.equal(terminal.code, 1);
      } finally { await f.cleanup(); }
    });
  }
});

test("real exec process emits a single runtime failure only after failing resource cleanup", { timeout: 20_000 }, async () => {
  const f = await fixture("cleanup-failure");
  try {
    const chunks: Buffer[] = [];
    f.child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    const [code] = await f.exit;
    await f.stdoutEnd;
    assert.equal(code, 1);
    await f.disposed();
    const records = Buffer.concat(chunks).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.filter((record) => record.type === "run_finished").length, 1);
    assert.equal(records.at(-1)?.status, "runtime_error");
  } finally { await f.cleanup(); }
});

test("real closed and stalled stdout pipes cancel and dispose before exit 1", { timeout: 35_000 }, async (t) => {
  for (const scenario of ["closed", "stall"]) {
    await t.test(scenario, async () => {
      const f = await fixture(scenario);
      try {
        if (scenario === "closed") {
          let prefix = "";
          f.child.stdout.on("data", (chunk: Buffer) => {
            prefix += chunk.toString("utf8");
            if (prefix.includes('"type":"assistant_message"')) f.child.stdout.destroy();
          });
        }
        const [code] = await f.exit;
        assert.equal(code, 1, f.stderr());
        await f.disposed();
        const terminal = JSON.parse(await fs.readFile(path.join(f.directory, "exit.json"), "utf8")) as { code: number };
        assert.equal(terminal.code, 1);
      } finally { await f.cleanup(); }
    });
  }
});

test("exec subprocess signal handlers cancel the production task and wait for disposal", { timeout: 35_000 }, async (t) => {
  for (const [signal, expected] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    await t.test(`${signal}${process.platform === "win32" ? " (Windows IPC delivery to process handler)" : " (OS signal)"}`, async () => {
      const f = await fixture(`signal-${signal}`);
      try {
        f.child.stdout.resume();
        await f.ready;
        if (process.platform === "win32") f.child.send({ signal });
        else f.child.kill(signal);
        const [code] = await f.exit;
        assert.equal(code, expected, f.stderr());
        await f.disposed();
      } finally { await f.cleanup(); }
    });
  }
});

test("a signal during a partially written assistant frame stops the writer and cleans up without a final frame", { timeout: 20_000 }, async () => {
  const f = await fixture("output-signal");
  try {
    let prefix = "";
    let signalled = false;
    f.child.stdout.on("data", (chunk: Buffer) => {
      prefix += chunk.toString("utf8");
      if (!signalled && prefix.includes('"type":"assistant_message"')) {
        signalled = true;
        f.child.stdout.pause();
        if (process.platform === "win32") f.child.send({ signal: "SIGINT" });
        else f.child.kill("SIGINT");
      }
    });
    const [code] = await f.exit;
    assert.equal(signalled, true);
    assert.equal(code, 130, f.stderr());
    assert.equal(prefix.includes('"type":"run_finished"'), false);
    await f.disposed();
  } finally { await f.cleanup(); }
});
