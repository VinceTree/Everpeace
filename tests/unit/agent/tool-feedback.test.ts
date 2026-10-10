import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ReactAgent } from "../../../src/agent/react-agent.js";
import { runFileTool } from "../../../src/tools/files.js";
import { createBundledRipgrepResolver } from "../../../src/tools/ripgrep.js";
import { ToolFeedbackError } from "../../../src/tools/tool-feedback.js";

function call(name: string, args: unknown, id = name) {
  return { type: "function_call", name, call_id: id, arguments: JSON.stringify(args) };
}

test("invalid built-in arguments return field remedies in model order without executing commands or patches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-tool-feedback-"));
  try {
    let executions = 0;
    let samples = 0;
    const outputs: Array<Record<string, unknown>> = [];
    const calls = [
      call("read_file", { path: "absent.txt", max_lines: 1001 }),
      call("search_files", { query: "needle", max_results: 201 }),
      call("glob_files", { pattern: "" }),
      call("bash", { command: " " }),
      call("start_background", { command: "check", timeout_ms: 10 }),
      call("poll_background", { job_id: "" }),
      call("apply_patch", { operations: [] }),
    ];
    const agent = new ReactAgent({ model: "offline", workspacePath: root,
      client: { responses: { async create() { samples += 1; return samples === 1 ? { id: "invalid", output: calls, output_text: "" } : { id: "done", output: [], output_text: "Correct the arguments" }; } } },
      io: {
        getPermissions: () => ({ mode: "workspace-write", web: false }),
        async confirmBash() { executions += 1; return true; },
        async runBash() { executions += 1; return { stdout: "", stderr: "", exitCode: 0, signal: null }; },
        async runApplyPatch() { executions += 1; return { status: "applied", files: [] }; },
        writeAssistant() {},
      },
      async onHistoryAppend(items) { outputs.push(...items.filter((item) => item.type === "function_call_output")); },
    });
    await agent.runTurn("test invalid arguments");
    assert.equal(executions, 0);
    assert.equal(samples, 2);
    assert.deepEqual(outputs.map((item) => item.call_id), calls.map((item) => item.call_id));
    for (const item of outputs) {
      const feedback = JSON.parse(String(item.output)) as Record<string, unknown>;
      assert.equal(feedback.errorCode, "INVALID_ARGUMENTS");
      assert.ok(String(feedback.remedy).length > 20);
    }
    assert.match(String(outputs[0]?.output), /max_lines.*1000/u);
    assert.match(String(outputs[1]?.output), /max_results.*200/u);
    assert.deepEqual(await fs.readdir(root), []);
    await agent.dispose();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("explicit file and search failures carry codes, while arbitrary exceptions are not guessed from text", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-typed-feedback-"));
  try {
    let resolves = 0;
    await assert.rejects(runFileTool("search_files", '{"query":"x","regex":"yes"}', root, undefined, undefined, async () => { resolves += 1; return "unused"; }), (error: unknown) => error instanceof ToolFeedbackError && error.code === "INVALID_ARGUMENTS" && error.remedy.includes("regex"));
    assert.equal(resolves, 0);
    await assert.rejects(runFileTool("read_file", '{"path":"../private"}', root), (error: unknown) => error instanceof ToolFeedbackError && error.code === "POLICY_DENIED" && error.remedy.includes("bypass"));
    const missing = createBundledRipgrepResolver(async () => { throw new Error("fixture platform unavailable"); });
    await assert.rejects(runFileTool("search_files", '{"query":"x"}', root, undefined, undefined, missing), (error: unknown) => error instanceof ToolFeedbackError && error.code === "TOOL_UNAVAILABLE");
    let samples = 0;
    let feedback = "";
    const agent = new ReactAgent({ model: "offline", workspacePath: root,
      client: { responses: { async create() { samples += 1; return samples === 1 ? { id: "call", output: [call("bash", { command: "check" })], output_text: "" } : { id: "done", output: [], output_text: "Stopped" }; } } },
      io: { getPermissions: () => ({ mode: "workspace-write", web: false }), async confirmBash() { return false; }, async runBash() { throw new Error("Invalid arguments; permission denied; timed out (arbitrary fixture text)"); }, writeAssistant() {} },
      async onHistoryAppend(items) { for (const item of items) if (item.type === "function_call_output") feedback = String(item.output); },
    });
    await agent.runTurn("check");
    assert.equal(samples, 2);
    assert.equal(JSON.parse(feedback).errorCode, undefined);
    assert.equal(JSON.parse(feedback).remedy, undefined);
    await agent.dispose();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("denied shell and patch calls provide policy remedies without approval or side effects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-denial-feedback-"));
  try {
    let executions = 0;
    let samples = 0;
    const feedback: Array<Record<string, unknown>> = [];
    const agent = new ReactAgent({ model: "offline", workspacePath: root,
      client: { responses: { async create() { samples += 1; return samples === 1 ? { id: "denied", output_text: "", output: [call("bash", { command: "check" }), call("start_background", { command: "check" }), call("apply_patch", { operations: [{ path: "a.txt", action: "create", content: "unsafe" }] })] } : { id: "done", output: [], output_text: "Denied" }; } } },
      io: { getPermissions: () => ({ mode: "read-only", web: false, commandRules: [{ prefix: "check", action: "deny" }] }), async confirmBash() { executions += 1; return true; }, async runBash() { executions += 1; return { stdout: "", stderr: "", exitCode: 0, signal: null }; }, async runApplyPatch() { executions += 1; return { status: "applied", files: [] }; }, writeAssistant() {} },
      async onHistoryAppend(items) { for (const item of items) if (item.type === "function_call_output") feedback.push(JSON.parse(String(item.output))); },
    });
    await agent.runTurn("denial checks");
    assert.equal(executions, 0);
    assert.equal(feedback.length, 3);
    for (const output of feedback) { assert.equal(output.errorCode, "POLICY_DENIED"); assert.match(String(output.remedy), /bypass/u); }
    assert.deepEqual(await fs.readdir(root), []);
    await agent.dispose();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("foreground and background timeouts preserve partial output with remedies and no replay", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-timeout-feedback-"));
  try {
    let samples = 0;
    const commands: string[] = [];
    const feedback: Array<Record<string, unknown>> = [];
    const agent = new ReactAgent({ model: "offline", workspacePath: root,
      client: { responses: { async create(params) {
        samples += 1;
        if (samples === 1) return { id: "timeouts", output_text: "", output: [call("bash", { command: "foreground" }), call("start_background", { command: "background" })] };
        if (samples === 2) {
          const items = params.input as Array<Record<string, unknown>>;
          const result = JSON.parse(String(items.find((item) => item.call_id === "start_background" && item.type === "function_call_output")?.output));
          return { id: "poll", output_text: "", output: [call("poll_background", { job_id: result.job.job_id })] };
        }
        return { id: "done", output_text: "Inspect side effects first", output: [] };
      } } },
      io: { getPermissions: () => ({ mode: "workspace-write", web: false }), async confirmBash() { return false; }, async runBash(command) { commands.push(command); return { stdout: "partial write completed", stderr: "still pending", exitCode: null, signal: null, timedOut: true, error: "fixture deadline" }; }, writeAssistant() {} },
      async onHistoryAppend(items) { for (const item of items) if (item.type === "function_call_output") feedback.push(JSON.parse(String(item.output))); },
    });
    await agent.runTurn("run bounded commands");
    assert.deepEqual(commands, ["foreground", "background"]);
    assert.equal(feedback[0]?.errorCode, "COMMAND_TIMEOUT");
    assert.equal(feedback[0]?.stdout, "partial write completed");
    const result = (feedback[2]!.job as { result: Record<string, unknown> }).result;
    assert.equal(result.errorCode, "COMMAND_TIMEOUT");
    assert.equal(result.stdout, "partial write completed");
    assert.match(String(result.remedy), /do not blindly replay/u);
    await agent.dispose();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
