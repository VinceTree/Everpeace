import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecOptions, ExecResult } from "../../../src/exec/types.js";
import type { ModelRegistry } from "../../../src/storage/model-registry.js";
import {
  runExecCommand,
  type ExecCommandHost,
} from "../../../src/cli/commands/exec.js";
import type { ExecCliOptions } from "../../../src/cli/args.js";

function host(stdinIsTTY = true, stdinText = "") {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let signal: ((code: 130 | 143) => void) | undefined;
  let outputError: ((error: Error) => void) | undefined;
  const value: ExecCommandHost & {
    stdout: string[];
    stderr: string[];
    signal(code: 130 | 143): void;
    outputError(error: Error): void;
  } = {
    cwd: () => "C:\\workspace",
    stdinIsTTY,
    async readStdin(abortSignal) {
      abortSignal.throwIfAborted();
      return stdinText;
    },
    writeStdout(text) { stdout.push(text); },
    writeStderr(text) { stderr.push(text); },
    onSignal(handler) { signal = handler; return () => { signal = undefined; }; },
    onStdoutError(handler) { outputError = handler; return () => { outputError = undefined; }; },
    stdout,
    stderr,
    signal(code) { signal?.(code); },
    outputError(error) { outputError?.(error); },
  };
  return value;
}

const registry = {} as ModelRegistry;

function options(overrides: Partial<ExecCliOptions> = {}): ExecCliOptions {
  return { command: "exec", help: false, json: false, prompt: "do work", ...overrides };
}

function result(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    exitCode: 0,
    classification: "success",
    status: "verified",
    sessionId: "session-1",
    assistantText: "finished",
    usageComplete: true,
    workflowResult: "verified",
    ...overrides,
  };
}

test("exec command rejects simultaneous positional and piped prompts before startup", async () => {
  const io = host(false, "piped prompt");
  let called = false;
  let registryCreated = false;
  const exit = await runExecCommand(options(), async () => {
    registryCreated = true;
    return registry;
  }, io, {
    async run() { called = true; return result(); },
  });
  assert.equal(exit, 2);
  assert.equal(called, false);
  assert.equal(registryCreated, false);
  assert.match(io.stderr.join(""), /either an argument or stdin/u);
});

test("exec command rejects blank piped input before loading credentials", async () => {
  const io = host(false, " \r\n\t ");
  const pipedOptions = options();
  delete pipedOptions.prompt;
  let registryCreated = false;
  const exit = await runExecCommand(pipedOptions, async () => {
    registryCreated = true;
    return registry;
  }, io, {
    async run() { throw new Error("runtime must not start"); },
  });
  assert.equal(exit, 2);
  assert.equal(registryCreated, false);
  assert.match(io.stderr.join(""), /non-blank exec prompt/u);
});

test("a signal while reading stdin exits before credentials or runtime are loaded", async () => {
  const io = host(false, "piped prompt");
  io.readStdin = async () => {
    io.signal(130);
    return "piped prompt";
  };
  let registryCreated = false;
  let runtimeStarted = false;
  const pipedOptions = options();
  delete pipedOptions.prompt;
  const exit = await runExecCommand(pipedOptions, async () => {
    registryCreated = true;
    return registry;
  }, io, {
    async run() { runtimeStarted = true; return result(); },
  });
  assert.equal(exit, 130);
  assert.equal(registryCreated, false);
  assert.equal(runtimeStarted, false);
});

test("a signal does not wait for a stalled credential-store startup", async () => {
  const io = host();
  let registryStarted!: () => void;
  const started = new Promise<void>((resolve) => { registryStarted = resolve; });
  const running = runExecCommand(options({ json: true }), async () => {
    registryStarted();
    return new Promise<never>(() => {});
  }, io, {
    async run() { throw new Error("runtime must not start"); },
  });
  await started;
  io.signal(143);
  assert.equal(await running, 143);
  const final = JSON.parse(io.stdout.join("").trim()) as Record<string, unknown>;
  assert.equal(final.type, "run_finished");
  assert.equal(final.status, "cancelled");
  assert.equal(final.stop_reason, "aborted");
});

test("exec command maps lazy registry startup failures to exit 2", async () => {
  const io = host();
  const exit = await runExecCommand(options({ json: true }), async () => {
    throw new Error("keyring unavailable");
  }, io);
  assert.equal(exit, 2);
  assert.match(io.stderr.join(""), /startup configuration failed.*keyring unavailable/iu);
  const final = JSON.parse(io.stdout.join("").trim()) as Record<string, unknown>;
  assert.equal(final.type, "run_finished");
  assert.equal(final.status, "configuration_error");
});

test("exec command emits allowlisted JSONL progress and one final result", async () => {
  const io = host();
  const exit = await runExecCommand(options({ json: true }), registry, io, {
    async run(runtimeOptions) {
      await runtimeOptions.onEvent?.({
        type: "session_started",
        sessionId: "session-1",
        modelId: "model-1",
        modelName: "offline",
        workspacePath: "C:\\workspace",
      });
      await runtimeOptions.onEvent?.({
        type: "assistant_message",
        text: "\u001b[31mAuthorization: Bearer abcdefghijklmnop\u001b[0m",
      });
      return result({
        usage: {
          attempts: [], inputTokens: 12, outputTokens: 4, reasoningTokens: 2,
          complete: true,
        },
      });
    },
  });
  assert.equal(exit, 0);
  const lines = io.stdout.join("").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(lines.map((line) => line.type), ["session_started", "assistant_message", "run_finished"]);
  assert.equal(lines.filter((line) => line.type === "run_finished").length, 1);
  assert.equal(JSON.stringify(lines).includes("abcdefghijklmnop"), false);
  assert.equal(JSON.stringify(lines).includes("\u001b"), false);
  assert.deepEqual(lines.at(-1)?.usage, { input_tokens: 12, output_tokens: 4, reasoning_tokens: 2 });
});

test("plain exec reserves stdout for the final assistant text", async () => {
  const io = host();
  const exit = await runExecCommand(options(), registry, io, {
    async run(runtimeOptions) {
      await runtimeOptions.onEvent?.({ type: "tool_started", name: "read_file", callId: "call-1" });
      await runtimeOptions.onEvent?.({ type: "assistant_message", text: "intermediate" });
      return result({ assistantText: "final answer", workflowResult: "no_changes", status: "no_changes" });
    },
  });
  assert.equal(exit, 0);
  assert.equal(io.stdout.join(""), "final answer\n");
  assert.match(io.stderr.join(""), /Tool: read_file/u);
  assert.match(io.stderr.join(""), /Host verification: no_changes/u);
});

test("signals retain 130/143 and stdout EPIPE cancels with cleanup-compatible exit", async (t) => {
  await t.test("SIGTERM", async () => {
    const io = host();
    const exit = await runExecCommand(options(), registry, io, {
      async run(runtimeOptions: ExecOptions) {
        io.signal(143);
        assert.equal(runtimeOptions.signal?.aborted, true);
        return result({ exitCode: runtimeOptions.signalExitCode ?? 1, classification: "cancelled", status: "cancelled" });
      },
    });
    assert.equal(exit, 143);
  });

  await t.test("EPIPE", async () => {
    const io = host();
    const exit = await runExecCommand(options(), registry, io, {
      async run(runtimeOptions) {
        io.outputError(Object.assign(new Error("closed"), { code: "EPIPE" }));
        assert.equal(runtimeOptions.signal?.aborted, true);
        return result({ exitCode: 1, classification: "cancelled", status: "output_closed" });
      },
    });
    assert.equal(exit, 1);
    assert.equal(io.stdout.length, 0);
  });
});
