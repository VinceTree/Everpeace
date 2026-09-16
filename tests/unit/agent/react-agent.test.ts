import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ReactAgent,
  type AgentIO,
  type ResponsesClientLike,
} from "../../../src/agent/react-agent.js";
import type { BashResult } from "../../../src/tools/bash.js";

function bashResult(stdout: string): BashResult {
  return { stdout, stderr: "", exitCode: 0, signal: null };
}

test("agent returns a final answer without running Bash", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const messages: string[] = [];
  const client: ResponsesClientLike = {
    responses: {
      async create(params) {
        requests.push(params);
        return { id: "response-1", output_text: "Hello", output: [] };
      },
    },
  };
  const io: AgentIO = {
    async confirmBash() {
      throw new Error("Bash should not be requested");
    },
    async runBash() {
      throw new Error("Bash should not run");
    },
    writeAssistant(text) {
      messages.push(text);
    },
  };

  await new ReactAgent({ client, model: "deepseek-flash", io }).runTurn("hi");

  assert.deepEqual(messages, ["Hello"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.model, "deepseek-flash");
  assert.equal(requests[0]?.store, false);
  assert.deepEqual(requests[0]?.include, ["reasoning.encrypted_content"]);
});

test("agent confirms, runs Bash, and returns its output to the model", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const commands: string[] = [];
  const responses = [
    {
      id: "response-1",
      output_text: "I will inspect the directory.",
      output: [
        {
          type: "function_call",
          name: "bash",
          arguments: '{"command":"pwd"}',
          call_id: "call-1",
        },
      ],
    },
    { id: "response-2", output_text: "Done", output: [] },
  ];
  const client: ResponsesClientLike = {
    responses: {
      async create(params) {
        requests.push(params);
        const response = responses.shift();
        assert.ok(response);
        return response;
      },
    },
  };
  const agent = new ReactAgent({
    client,
    model: "deepseek-flash",
    io: {
      async confirmBash(command) {
        commands.push(command);
        return true;
      },
      async runBash(command) {
        assert.equal(command, "pwd");
        return bashResult("/repo\n");
      },
      writeAssistant() {},
    },
  });

  await agent.runTurn("where am I?");

  assert.deepEqual(commands, ["pwd"]);
  assert.equal(requests[1]?.previous_response_id, undefined);
  const history = requests[1]?.input as Array<Record<string, unknown>>;
  assert.equal(history[0]?.role, "user");
  assert.equal(history[1]?.type, "function_call");
  const toolOutput = history.find((item) => item.type === "function_call_output");
  assert.ok(toolOutput);
  assert.match(String(toolOutput.output), /\/repo/);
});

test("agent tells the model when the user rejects Bash", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const responses = [
    {
      id: "response-1",
      output_text: "",
      output: [
        {
          type: "function_call",
          name: "bash",
          arguments: '{"command":"rm file"}',
          call_id: "call-1",
        },
      ],
    },
    { id: "response-2", output_text: "I did not run it.", output: [] },
  ];
  const client: ResponsesClientLike = {
    responses: {
      async create(params) {
        requests.push(params);
        const response = responses.shift();
        assert.ok(response);
        return response;
      },
    },
  };
  const agent = new ReactAgent({
    client,
    model: "deepseek-flash",
    io: {
      async confirmBash() {
        return false;
      },
      async runBash() {
        throw new Error("Rejected command must not run");
      },
      writeAssistant() {},
    },
  });

  await agent.runTurn("delete the file");

  const history = requests[1]?.input as Array<Record<string, unknown>>;
  const toolOutput = history.find((item) => item.type === "function_call_output");
  assert.ok(toolOutput);
  assert.match(String(toolOutput.output), /rejected/);
});

test("agent keeps the final response as context for the next turn", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let responseNumber = 0;
  const client: ResponsesClientLike = {
    responses: {
      async create(params) {
        requests.push(params);
        responseNumber += 1;
        return {
          id: `response-${responseNumber}`,
          output_text: "ok",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
        };
      },
    },
  };
  const agent = new ReactAgent({
    client,
    model: "deepseek-flash",
    io: {
      async confirmBash() {
        return false;
      },
      async runBash() {
        return bashResult("");
      },
      writeAssistant() {},
    },
  });

  await agent.runTurn("first");
  await agent.runTurn("second");

  assert.equal(requests[1]?.previous_response_id, undefined);
  const history = requests[1]?.input as Array<Record<string, unknown>>;
  assert.equal(history[0]?.content, "first");
  assert.equal(history[1]?.role, "assistant");
  assert.equal(history[2]?.content, "second");
});

test("agent forwards an AbortSignal to every model request", async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const client: ResponsesClientLike = {
    responses: {
      async create(_params, options) {
        signals.push(options?.signal);
        return { id: "response-1", output_text: "done", output: [] };
      },
    },
  };
  const controller = new AbortController();
  const agent = new ReactAgent({
    client,
    model: "deepseek-flash",
    io: {
      async confirmBash() {
        return false;
      },
      async runBash() {
        return bashResult("");
      },
      writeAssistant() {},
    },
  });

  await agent.runTurn("hello", controller.signal);

  assert.deepEqual(signals, [controller.signal]);
});

test("agent restores prior context and persists each new context batch", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const persisted: Array<readonly Record<string, unknown>[]> = [];
  const assistantItem = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "continued" }],
  };
  const agent = new ReactAgent({
    client: {
      responses: {
        async create(params) {
          requests.push(structuredClone(params));
          return {
            id: "response-restored",
            output_text: "continued",
            output: [assistantItem],
          };
        },
      },
    },
    model: "deepseek-flash",
    io: {
      async confirmBash() {
        return false;
      },
      async runBash() {
        return bashResult("");
      },
      writeAssistant() {},
    },
    initialHistory: [
      { role: "user", content: "before restart" },
      { type: "message", role: "assistant", content: "old answer" },
    ],
    async onHistoryAppend(items) {
      persisted.push(items.map((item) => ({ ...item })));
    },
  });

  await agent.runTurn("after restart");

  assert.deepEqual(requests[0]?.input, [
    { role: "user", content: "before restart" },
    { type: "message", role: "assistant", content: "old answer" },
    { role: "user", content: "after restart" },
  ]);
  assert.deepEqual(persisted, [
    [{ role: "user", content: "after restart" }],
    [assistantItem],
  ]);
});
