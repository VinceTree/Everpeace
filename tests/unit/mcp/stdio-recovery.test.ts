import { approvedMcpFixture } from "../../fixtures/mcp-trust.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { McpRuntime } from "../../../src/mcp/runtime.js";

const fixturePath = fileURLToPath(new URL("../../fixtures/mcp-stdio-recovery.ts", import.meta.url));
interface FixtureEvent {
  event: string;
  pid: number;
  generation: number;
  at: number;
  name?: string;
  previous_alive?: boolean;
}

function readEvents(path: string): FixtureEvent[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as FixtureEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Stdio recovery fixture condition was not reached");
    await delay(20);
  }
}

async function fixture(t: TestContext, mode: "disconnect" | "initialize_timeout") {
  const directory = await mkdtemp(join(tmpdir(), "everpeace-stdio-recovery-"));
  const logPath = join(directory, "calls.jsonl");
  const runtime = new McpRuntime({ trustStore: approvedMcpFixture(),
    workspacePath: process.cwd(),
    async loadConfig() {
      return [{
        name: "fixture", enabled: true,
        transport: { type: "stdio", isolation: "host", command: process.execPath, args: ["--import", "tsx", fixturePath, mode, logPath] },
        // This deadline includes Node/tsx/SDK cold startup on hosted Windows.
        // Generation 1 deliberately never initializes in timeout mode, so a
        // longer deadline preserves the timeout assertion without timing out
        // the healthy replacement and accidentally starting generation 3.
        startup_timeout_sec: 10,
        tool_timeout_sec: 5,
      }];
    },
  });
  t.after(async () => {
    try { await runtime.close(); }
    finally {
      // Cleanup also owns fixtures orphaned by a failed lifecycle assertion.
      for (const entry of readEvents(logPath).filter((item) => item.event === "started")) {
        try { process.kill(entry.pid, "SIGKILL"); } catch { /* The fixture has already exited. */ }
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
  return { runtime, events: () => readEvents(logPath) };
}

test("real stdio disconnect reconnects for later calls without replaying the interrupted call", { timeout: 45_000 }, async (t) => {
  const { runtime, events } = await fixture(t, "disconnect");
  const first = await runtime.ensureReady();
  assert.equal(first.servers[0]?.state, "ready");
  const binding = runtime.toolInfo("mcp__fixture__disconnect")?.binding;
  const pingBinding = runtime.toolInfo("mcp__fixture__ping")?.binding;
  assert.ok(binding);
  assert.ok(pingBinding);
  const interrupted = JSON.parse(await runtime.call("mcp__fixture__disconnect", '{"request":"once"}', binding));
  assert.equal(interrupted.status, "error");
  assert.equal(runtime.snapshot().tools.length, 0, "a closed connection must immediately leave the callable directory");
  await until(() => runtime.snapshot().servers[0]?.state === "ready"
    && runtime.toolInfo("mcp__fixture__ping")?.binding !== pingBinding);
  assert.equal(events().filter((entry) => entry.event === "call" && entry.name === "disconnect").length, 1);
  assert.match(await runtime.call("mcp__fixture__ping", "{}", pingBinding), /binding is stale/u);
  assert.equal(events().filter((entry) => entry.event === "call" && entry.name === "ping").length, 0);
  const currentBinding = runtime.toolInfo("mcp__fixture__ping")?.binding;
  assert.ok(currentBinding);
  assert.match(await runtime.call("mcp__fixture__ping", "{}", currentBinding), /pong from generation 2/u);
  assert.deepEqual(events().filter((entry) => entry.event === "call").map(({ name, generation }) => ({ name, generation })), [
    { name: "disconnect", generation: 1 }, { name: "ping", generation: 2 },
  ]);
  assert.deepEqual(events().filter((entry) => entry.event === "started").map((entry) => entry.previous_alive), [false, false]);
});

test("real stdio initialize timeout closes a slow partial client before reconnecting", { timeout: 45_000 }, async (t) => {
  const { runtime, events } = await fixture(t, "initialize_timeout");
  const initial = await runtime.ensureReady();
  assert.equal(initial.servers[0]?.state, "reconnecting");
  assert.equal(initial.tools.length, 0);
  await until(() => runtime.snapshot().servers[0]?.state === "ready");
  assert.match(await runtime.call("mcp__fixture__ping", "{}"), /pong from generation 2/u);
  const records = events();
  const firstStart = records.find((entry) => entry.event === "started" && entry.generation === 1);
  const stdinEnded = records.find((entry) => entry.event === "stdin_end" && entry.generation === 1);
  const firstExit = records.find((entry) => entry.event === "exiting" && entry.generation === 1);
  const secondStart = records.find((entry) => entry.event === "started" && entry.generation === 2);
  assert.ok(firstStart);
  assert.ok(stdinEnded, "timeout must close the partial client's transport");
  assert.ok(firstExit, "the first child deliberately takes longer than reconnect backoff to close");
  assert.ok(secondStart);
  assert.equal(records.filter((entry) => entry.event === "initialize_stalled").length, 1);
  assert.equal(records.filter((entry) => entry.event === "started").length, 2);
  assert.ok(firstExit.at - stdinEnded.at >= 1_200);
  assert.ok(secondStart.at >= firstExit.at, "a new process must not start before the old child exits");
  assert.equal(secondStart.previous_alive, false, "the replacement must confirm the previous child is no longer alive");
});
