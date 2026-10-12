import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXEC_JSONL_SCHEMA_VERSION,
  EXEC_JSONL_EVENT_MAX_BYTES,
  ExecJsonlEmitter,
  sanitizeExecOutput,
  serializeExecJsonlEvent,
  type ExecAssistantMessageEvent,
  type ExecJsonlEvent,
} from "../../../src/cli/exec-output.js";

const timestamp = new Date("2026-10-02T03:04:05.000Z");

test("performance and evidence JSONL admit fixed measurements and reject hidden private fields", async () => {
  const { TaskPerformance } = await import("../../../src/performance/task-report.js");
  const trace = new TaskPerformance(); trace.begin(); trace.timing("verification", 15); const report = trace.finish()!;
  const safe = JSON.parse(serializeExecJsonlEvent({ type: "performance_report", report }, timestamp));
  assert.equal(safe.report.timings.verification.totalMs, 15); assert.match(safe.notice, /overlap/u);
  const forged = { ...report, path: "private-customer-path" };
  const rejected = serializeExecJsonlEvent({ type: "performance_report", report: forged }, timestamp);
  assert.doesNotMatch(rejected, /private-customer-path/u); assert.equal(JSON.parse(rejected).unavailable, true);
  const evidence = { version: 1 as const, projectChecks: "none" as const, tests: { state: "unknown" as const, assertions: "unknown" as const }, coverage: { state: "unknown" as const, changedFiles: 0, measuredFiles: 0 }, independent: "not_run" as const, source: "project_checks" as const, modifiedTests: false, reportDigests: [], rawParameters: "private-token-fragment" };
  const workflow = serializeExecJsonlEvent({ type: "workflow_updated", phase: "review", verificationEvidence: evidence }, timestamp);
  assert.doesNotMatch(workflow, /private-token-fragment|verification_evidence/u);
});

test("serializeExecJsonlEvent emits a versioned allowlisted session event", () => {
  const line = serializeExecJsonlEvent({
    type: "session_started",
    sessionId: "session-1",
    modelId: "registration-1",
    modelName: "deepseek-chat",
    workspacePath: "C:\\work tree",
  }, timestamp);

  assert.deepEqual(JSON.parse(line), {
    schema_version: EXEC_JSONL_SCHEMA_VERSION,
    type: "session_started",
    timestamp: timestamp.toISOString(),
    session_id: "session-1",
    model_id: "registration-1",
    model_name: "deepseek-chat",
    workspace: "C:\\work tree",
  });
});

test("assistant frames preserve complete redacted text and never split or interleave JSON", async () => {
  const body = `${"😀中\\\"\r\n".repeat(30_000)}Authorization: Bearer abcdefghijklmnop\n\ud800`;
  const chunks: string[] = [];
  let first!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { first = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const emitter = new ExecJsonlEmitter({
    async write(chunk) {
      chunks.push(chunk);
      if (chunks.length === 1) { first(); await gate; }
    },
    now: () => timestamp,
  });
  const assistant = emitter.emit({ type: "assistant_message", text: body });
  await entered;
  const tool = emitter.emit({ type: "tool_started", name: "read_file" });
  assert.equal(chunks.length, 1, "only the frame prefix is buffered while its consumer waits");
  release();
  await Promise.all([assistant, tool]);
  const records = chunks.join("").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(records.length, 2);
  assert.equal(records[0]?.text, sanitizeExecOutput(body, Number.MAX_SAFE_INTEGER));
  assert.equal(records[0]?.truncated, undefined);
  assert.equal(records[0]?.text_total_bytes, undefined);
  assert.equal(records[1]?.type, "tool_started");
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 16 * 1024));
  assert.equal(chunks.join("").includes("abcdefghijklmnop"), false);
});

test("non-assistant JSONL bounds complete escaped lines and exposes truncation", () => {
  for (const event of [
    { type: "session_started" as const, sessionId: "\u0001".repeat(10_000), modelId: "\u0001".repeat(10_000), modelName: "\u0001".repeat(10_000), workspacePath: "\u0001".repeat(10_000) },
    { type: "workflow_updated" as const, phase: "verify_full" as const, taskId: "task-1", changedPaths: Array.from({ length: 1000 }, () => "\u0001\\😀".repeat(2000)), resultReason: "\u0001".repeat(80_000) },
    { type: "interaction_required" as const, kind: "question" as const, prompt: "\u0001".repeat(80_000) },
  ]) {
    const line = serializeExecJsonlEvent(event, timestamp);
    assert.ok(Buffer.byteLength(line) + 1 <= EXEC_JSONL_EVENT_MAX_BYTES);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.type, event.type);
    assert.equal(parsed.schema_version, 1);
    if (event.type === "session_started") {
      for (const field of ["session_id", "model_id", "model_name", "workspace"]) assert.equal(typeof parsed[field], "string");
    }
    if (event.type === "workflow_updated") {
      assert.equal(parsed.changed_paths_total, 1000);
      assert.equal(parsed.changed_paths_returned, (parsed.changed_paths as string[]).length);
      assert.ok(Number(parsed.changed_paths_returned) < 1000);
    }
  }
});

test("escaped display previews retain their complete redacted byte totals after line reduction", () => {
  const text = `\u001b[31mAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\u001b[0m\n${"\u0001".repeat(20_000)}`;
  const safe = sanitizeExecOutput(text, Number.MAX_SAFE_INTEGER);
  const cases: Array<{ field: string; event: ExecJsonlEvent }> = [
    { field: "output", event: { type: "tool_finished", name: "shell", callId: "call-1", status: "failed", output: text } },
    { field: "prompt", event: { type: "interaction_required", kind: "question", tool: "ask_question", callId: "call-2", prompt: text } },
    { field: "result_reason", event: { type: "workflow_updated", phase: "verify_full", taskId: "task-1", result: "unverified", resultReason: text } },
  ];
  assert.ok(Buffer.byteLength(safe) < 32 * 1024, "the source fits the initial per-field preview limit");
  for (const { field, event } of cases) {
    const line = serializeExecJsonlEvent(event, timestamp);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.ok(Buffer.byteLength(line) + 1 <= EXEC_JSONL_EVENT_MAX_BYTES);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed[`${field}_total_bytes`], Buffer.byteLength(safe));
    assert.notEqual(parsed[`${field}_total_bytes`], Buffer.byteLength(text), "counts use sanitized text before clipping");
    assert.ok(Buffer.byteLength(String(parsed[field])) < Buffer.byteLength(safe), "JSON escaping triggers a second reduction");
    assert.equal(line.includes("abcdefghijklmnopqrstuvwxyz"), false);
    if (event.type === "tool_finished") {
      assert.equal(parsed.name, event.name);
      assert.equal(parsed.call_id, event.callId);
      assert.equal(parsed.status, event.status);
    } else if (event.type === "interaction_required") {
      assert.equal(parsed.kind, event.kind);
      assert.equal(parsed.tool, event.tool);
      assert.equal(parsed.call_id, event.callId);
    } else if (event.type === "workflow_updated") {
      assert.equal(parsed.phase, event.phase);
      assert.equal(parsed.task_id, event.taskId);
      assert.equal(parsed.result, event.result);
    }
  }
});

test("changed path counts follow the delivered array after secondary JSONL reduction", () => {
  const changedPaths = Array.from({ length: 1000 }, (_, index) => `${index}-${"x".repeat(40)}`);
  const resultReason = "\u0001".repeat(10_000);
  assert.ok(Buffer.byteLength(JSON.stringify(changedPaths)) < 48 * 1024, "all paths fit the initial preview budget");
  const line = serializeExecJsonlEvent({
    type: "workflow_updated", phase: "verify_full", taskId: "task-1", result: "unverified", changedPaths, resultReason,
  }, timestamp);
  const parsed = JSON.parse(line) as Record<string, unknown>;
  const returned = parsed.changed_paths as string[];
  assert.ok(Buffer.byteLength(line) + 1 <= EXEC_JSONL_EVENT_MAX_BYTES);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.changed_paths_total, 1000);
  assert.equal(parsed.changed_paths_returned, returned.length);
  assert.ok(returned.length > 0 && returned.length < changedPaths.length);
  assert.deepEqual(returned, changedPaths.slice(0, returned.length));
  assert.equal(parsed.result_reason_total_bytes, Buffer.byteLength(resultReason));
  assert.equal(parsed.task_id, "task-1");
  assert.equal(parsed.result, "unverified");
});

test("an interrupted assistant frame forbids a synthetic final JSONL record", async () => {
  let writes = 0;
  const emitter = new ExecJsonlEmitter({ write() { if (++writes === 2) throw new Error("pipe closed"); } });
  await assert.rejects(emitter.emit({ type: "assistant_message", text: "x".repeat(100_000) }), /pipe closed/);
  assert.equal(emitter.broken, true);
  await assert.rejects(emitter.finish({ type: "run_finished", status: "runtime_error", usageComplete: true }), /interrupted/);
  assert.equal(writes, 2);
});

test("exec JSONL strips ANSI, redacts credentials, and drops unknown provider fields", () => {
  const event = {
    type: "assistant_message",
    text: "\u001b[31mAuthorization: Bearer abcdefghijklmnop\u001b[0m",
    reasoning: "private chain of thought",
    raw_response: { secret: "raw provider value" },
  } as unknown as ExecAssistantMessageEvent;
  const parsed = JSON.parse(serializeExecJsonlEvent(event, timestamp)) as Record<string, unknown>;

  assert.equal(parsed.text, "Authorization: Bearer [secret redacted]");
  assert.equal("reasoning" in parsed, false);
  assert.equal("raw_response" in parsed, false);
  assert.equal(JSON.stringify(parsed).includes("\u001b"), false);
  assert.equal(JSON.stringify(parsed).includes("abcdefghijklmnop"), false);
});

test("exec tool and workflow output contains only bounded public fields", () => {
  const huge = `start sk-${"a".repeat(20)} ${"界".repeat(20_000)}`;
  const tool = JSON.parse(serializeExecJsonlEvent({
    type: "tool_finished",
    name: "shell",
    callId: "call-1",
    status: "completed",
    output: huge,
  }, timestamp)) as Record<string, unknown>;
  const workflow = JSON.parse(serializeExecJsonlEvent({
    type: "workflow_updated",
    phase: "verify_full",
    taskId: "task-1",
    result: "verified",
    changedPaths: ["src/index.ts"],
    repairAttempts: 1,
    maxRepairAttempts: 3,
    pendingVerification: false,
  }, timestamp)) as Record<string, unknown>;

  assert.equal(Buffer.byteLength(String(tool.output), "utf8") <= 32 * 1024, true);
  assert.match(String(tool.output), /\[secret redacted\]/);
  assert.match(String(tool.output), /\[truncated\]$/);
  assert.equal(tool.output_total_bytes, Buffer.byteLength(sanitizeExecOutput(huge, Number.MAX_SAFE_INTEGER)));
  assert.deepEqual(workflow.changed_paths, ["src/index.ts"]);
  assert.equal(workflow.changed_paths_total, 1);
  assert.equal(workflow.changed_paths_returned, 1);
  assert.equal(workflow.repair_attempts, 1);
  assert.equal(workflow.pending_verification, false);
});

test("ExecJsonlEmitter writes one final event after progress", async () => {
  const lines: string[] = [];
  const emitter = new ExecJsonlEmitter({ write: (line) => { lines.push(line); }, now: () => timestamp });

  await emitter.emit({ type: "tool_started", name: "read_file", callId: "call-1" });
  assert.equal(await emitter.finish({
    type: "run_finished",
    sessionId: "session-1",
    status: "success",
    usageComplete: true,
    workflowResult: "no_changes",
    usage: { inputTokens: 12, outputTokens: 4, reasoningTokens: 2 },
  }), true);
  assert.equal(await emitter.finish({
    type: "run_finished",
    sessionId: "session-1",
    status: "runtime_error",
    usageComplete: false,
  }), false);

  assert.equal(lines.length, 2);
  assert.equal(lines.every((line) => line.endsWith("\n")), true);
  assert.equal((JSON.parse(lines[1]!) as { type: string }).type, "run_finished");
  assert.deepEqual((JSON.parse(lines[1]!) as { usage: unknown }).usage, {
    input_tokens: 12,
    output_tokens: 4,
    reasoning_tokens: 2,
  });
  await assert.rejects(emitter.emit({ type: "assistant_message", text: "late" }), /after run_finished/);
});

test("sanitizeExecOutput handles private keys and Unicode byte boundaries", () => {
  const sanitized = sanitizeExecOutput(
    `\u001b[32m-----BEGIN PRIVATE KEY-----\nsecret-body\n-----END PRIVATE KEY-----\u001b[0m${"😀".repeat(10)}`,
    80,
  );
  assert.equal(sanitized.includes("\u001b"), false);
  assert.equal(sanitized.includes("secret-body"), false);
  assert.equal(Buffer.byteLength(sanitized, "utf8") <= 80, true);
  assert.equal(sanitized.includes("�"), false);
});
