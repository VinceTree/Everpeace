import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CliArgumentError,
  parseArgs,
  resolveExecPrompt,
  type ExecCliOptions,
} from "../../../src/cli/args.js";

test("parseArgs starts the agent by default", () => {
  assert.deepEqual(parseArgs([]), { command: "run", help: false });
});

test("parseArgs accepts authentication management commands", () => {
  assert.equal(parseArgs(["login"]).command, "login");
  assert.equal(parseArgs(["models"]).command, "models");
  assert.equal(parseArgs(["logout"]).command, "logout");
});

test("parseArgs recognizes help and rejects unsupported arguments", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["--model", "anything"]), /Unknown argument/);
  assert.throws(() => parseArgs(["login", "models"]), /Unknown argument/);
});

test("parseArgs accepts the complete exec command surface", () => {
  assert.deepEqual(
    parseArgs([
      "exec",
      "repair the fixture",
      "-C",
      "C:\\work tree",
      "--model",
      "registered-model",
      "--json",
      "--token-budget",
      "12000",
      "--timeout-ms",
      "60000",
      "--max-steps",
      "24",
    ]),
    {
      command: "exec",
      help: false,
      prompt: "repair the fixture",
      directory: "C:\\work tree",
      model: "registered-model",
      json: true,
      tokenBudget: 12000,
      timeoutMs: 60000,
      maxSteps: 24,
    },
  );
});

test("parseArgs keeps exec prompt optional for stdin and supports option termination", () => {
  assert.deepEqual(parseArgs(["exec", "--json"]), {
    command: "exec",
    help: false,
    json: true,
  });
  assert.deepEqual(parseArgs(["--help", "exec"]), {
    command: "exec",
    help: true,
    json: false,
  });
  assert.equal((parseArgs(["exec", "--", "-prompt"]) as ExecCliOptions).prompt, "-prompt");
});

test("parseArgs rejects invalid and unsafe exec integer values", () => {
  for (const value of ["0", "-1", "1.5", "01", "+1", "9007199254740992"]) {
    assert.throws(
      () => parseArgs(["exec", "prompt", "--token-budget", value]),
      (error) => error instanceof CliArgumentError && /positive integer/.test(error.message),
    );
  }
  assert.throws(() => parseArgs(["exec", "prompt", "--max-steps", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["exec", "prompt", "--timeout-ms", "NaN"]), /positive integer/);
});

test("parseArgs rejects missing, repeated, and unknown exec arguments", () => {
  assert.throws(() => parseArgs(["exec", "--model"]), /Missing value for --model/);
  assert.throws(() => parseArgs(["exec", "--model", ""]), /Missing value for --model/);
  assert.throws(() => parseArgs(["exec", "--model", "--json"]), /Missing value for --model/);
  assert.throws(() => parseArgs(["exec", "one", "two"]), /only one positional prompt/);
  assert.throws(() => parseArgs(["exec", "prompt", "--json", "--json"]), /only be specified once/);
  assert.throws(() => parseArgs(["exec", "prompt", "-C", "one", "-C", "two"]), /only be specified once/);
  assert.throws(() => parseArgs(["exec", "prompt", "--model", "one", "--model", "two"]), /only be specified once/);
  assert.throws(() => parseArgs(["exec", "prompt", "--max-steps", "1", "--max-steps", "2"]), /only be specified once/);
  assert.throws(() => parseArgs(["exec", "prompt", "--unknown"]), /Unknown argument/);
});

test("resolveExecPrompt enforces one positional or piped source", () => {
  const positional = parseArgs(["exec", "argument prompt"]) as ExecCliOptions;
  const piped = parseArgs(["exec"]) as ExecCliOptions;

  assert.equal(resolveExecPrompt(positional, { stdinIsTTY: true }), "argument prompt");
  assert.equal(resolveExecPrompt(positional, { stdinIsTTY: false, stdinText: "" }), "argument prompt");
  assert.equal(resolveExecPrompt(piped, { stdinIsTTY: false, stdinText: "piped\nprompt\n" }), "piped\nprompt\n");
  assert.throws(
    () => resolveExecPrompt(positional, { stdinIsTTY: false, stdinText: "also piped" }),
    /either an argument or stdin/,
  );
  assert.throws(() => resolveExecPrompt(piped, { stdinIsTTY: true }), /Missing exec prompt/);
  assert.throws(() => resolveExecPrompt(piped, { stdinIsTTY: false, stdinText: "" }), /did not contain/);
  assert.throws(() => resolveExecPrompt({ ...positional, prompt: " \r\n\t " }, { stdinIsTTY: true }), /cannot be blank/);
  assert.throws(() => resolveExecPrompt(piped, { stdinIsTTY: false, stdinText: " \r\n\t " }), /non-blank/);
});

test("exec resume requires an explicit local ID and a fresh prompt without a model override", () => {
  const resumed = parseArgs(["exec", "Continue the fix", "--resume", "session_1-abc", "-C", "project", "--json"]) as ExecCliOptions;
  assert.equal(resumed.resume, "session_1-abc");
  assert.equal(resolveExecPrompt(resumed, { stdinIsTTY: true }), "Continue the fix");
  for (const id of ["../session", "C:\\session", " ", "session.jsonl"]) {
    assert.throws(() => parseArgs(["exec", "--resume", id]), /local Session ID/u);
  }
  assert.throws(() => parseArgs(["exec", "--resume"]), /Missing value/u);
  assert.throws(() => parseArgs(["exec", "--resume", "one", "--resume", "two"]), /only be specified once/u);
  assert.throws(() => parseArgs(["exec", "--resume", "one", "--model", "other"]), /cannot be combined/u);
  assert.throws(() => resolveExecPrompt(parseArgs(["exec", "--resume", "one"]) as ExecCliOptions, { stdinIsTTY: true }), /Missing exec prompt/u);
});

test("exec plan is a repeat-rejected flag and combines with resume but not with a model override", () => {
  const planned = parseArgs(["exec", "Plan the refactor", "--plan"]) as ExecCliOptions;
  assert.equal(planned.plan, true);
  const resumedPlan = parseArgs(["exec", "Plan the refactor", "--plan", "--resume", "parent-1"]) as ExecCliOptions;
  assert.equal(resumedPlan.plan, true);
  assert.equal(resumedPlan.resume, "parent-1");
  assert.throws(() => parseArgs(["exec", "p", "--plan", "--plan"]), /only be specified once/u);
  assert.throws(() => parseArgs(["exec", "p", "--plan", "--resume", "one", "--model", "other"]), /cannot be combined/u);
});

test("exec permission mode selects a non-elevating tier and rejects full-access", () => {
  const restricted = parseArgs(["exec", "work", "--permission-mode", "read-only"]) as ExecCliOptions;
  assert.equal(restricted.permissionMode, "read-only");
  const asked = parseArgs(["exec", "work", "--permission-mode", "ask"]) as ExecCliOptions;
  assert.equal(asked.permissionMode, "ask");
  const write = parseArgs(["exec", "work", "--permission-mode", "workspace-write"]) as ExecCliOptions;
  assert.equal(write.permissionMode, "workspace-write");
  assert.throws(() => parseArgs(["exec", "work", "--permission-mode", "full-access"]), /read-only, ask, or workspace-write/u);
  assert.throws(() => parseArgs(["exec", "work", "--permission-mode", "bogus"]), /read-only, ask, or workspace-write/u);
  assert.throws(() => parseArgs(["exec", "work", "--permission-mode", "read-only", "--permission-mode", "ask"]), /only be specified once/u);
});
