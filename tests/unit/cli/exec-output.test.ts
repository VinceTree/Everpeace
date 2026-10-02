import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXEC_JSONL_SCHEMA_VERSION,
  ExecJsonlEmitter,
  sanitizeExecOutput,
  serializeExecJsonlEvent,
  type ExecAssistantMessageEvent,
} from "../../../src/cli/exec-output.js";

const timestamp = new Date("2026-10-02T03:04:05.000Z");

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
  assert.deepEqual(workflow.changed_paths, ["src/index.ts"]);
  assert.equal(workflow.repair_attempts, 1);
  assert.equal(workflow.pending_verification, false);
});

test("ExecJsonlEmitter writes one final event after progress", () => {
  const lines: string[] = [];
  const emitter = new ExecJsonlEmitter({ write: (line) => lines.push(line), now: () => timestamp });

  emitter.emit({ type: "tool_started", name: "read_file", callId: "call-1" });
  assert.equal(emitter.finish({
    type: "run_finished",
    sessionId: "session-1",
    status: "success",
    usageComplete: true,
    workflowResult: "no_changes",
    usage: { inputTokens: 12, outputTokens: 4, reasoningTokens: 2 },
  }), true);
  assert.equal(emitter.finish({
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
  assert.throws(() => emitter.emit({ type: "assistant_message", text: "late" }), /after run_finished/);
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
