import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ReactAgent,
  type AgentIO,
  type ResponsesClientLike,
} from "../../../src/agent/react-agent.js";
import type { BashResult } from "../../../src/tools/bash.js";
import type { PermissionPolicy } from "../../../src/permissions/policy.js";

function bashResult(stdout: string): BashResult {
  return { stdout, stderr: "", exitCode: 0, signal: null };
}

test("agent rejects overlapping turns and releases the guard after cancellation", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const agent = new ReactAgent({ model: "test", client: { responses: { async create(_params, options) {
    if (!options?.signal) return { id: "done", output: [], output_text: "done" };
    started();
    await new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
    return { id: "never", output: [], output_text: "" };
  } } }, io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} } });
  const first = agent.runTurn("first", controller.signal);
  await ready;
  await assert.rejects(agent.runTurn("overlap"), /already running/);
  controller.abort();
  await assert.rejects(first, /abort/i);
  await agent.runTurn("next");
});

test("agent exposes apply_patch and persists its structured result before continuing", async () => {
  const history: Array<Record<string, unknown>> = [];
  let patchCalls = 0;
  const agent = new ReactAgent({
    model: "test",
    client: {
      responses: {
        async create(params) {
          const input = params.input as Array<Record<string, unknown>>;
          history.push(...input.slice(-2));
          if (patchCalls++ === 0) {
            const tools = params.tools as Array<Record<string, unknown>>;
            assert.ok(tools.some((tool) => tool.name === "apply_patch"));
            return { id: "patch", output_text: "", output: [{ type: "function_call", name: "apply_patch", call_id: "patch-1", arguments: JSON.stringify({ operations: [{ path: "file.txt", action: "create", content: "done\n" }] }) }] };
          }
          assert.ok(input.some((item) => item.type === "function_call_output" && String(item.output).includes('"status":"applied"')));
          return { id: "done", output_text: "verified", output: [] };
        },
      },
    },
    io: {
      async confirmBash() { return true; },
      async runBash() { return bashResult(""); },
      async runApplyPatch() { return { status: "applied", files: [{ path: "file.txt", action: "create", status: "applied" }], diffSummary: "create file.txt" }; },
      writeAssistant() {},
    },
    onHistoryAppend: async (items) => { history.push(...items); },
  });
  await agent.runTurn("create file.txt");
  assert.ok(history.some((item) => item.type === "function_call" && item.name === "apply_patch"));
  assert.ok(history.some((item) => item.type === "function_call_output" && item.call_id === "patch-1"));
});

test("agent uses the native compaction output as the next context window", async () => {
  const createInputs: Array<Array<Record<string, unknown>>> = [];
  let compactInput: Array<Record<string, unknown>> | undefined;
  let saved: Array<Record<string, unknown>> = [];
  const compacted = [
    { type: "message", role: "user", content: "retained" },
    { type: "compaction", encrypted_content: "opaque" },
  ];
  const agent = new ReactAgent({
    model: "test",
    initialHistory: [{ role: "user", content: "old context" }],
    client: {
      responses: {
        async compact(params) {
          compactInput = params.input as Array<Record<string, unknown>>;
          return {
            output: compacted,
            usage: { input_tokens: 90, output_tokens: 10, total_tokens: 100 },
          };
        },
        async create(params) {
          createInputs.push(params.input as Array<Record<string, unknown>>);
          return { id: "done", output_text: "finished", output: [] };
        },
      },
    },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
    async onContextCompacted(items, automatic, usage) {
      assert.equal(automatic, false);
      assert.deepEqual(items, compacted);
      assert.deepEqual(usage, { input_tokens: 90, output_tokens: 10, total_tokens: 100 });
      saved = items.map((item) => ({ ...item }));
    },
  });

  const result = await agent.compact();
  assert.deepEqual(result.items, compacted);
  assert.deepEqual(compactInput, [{ role: "user", content: "old context" }]);
  await agent.runTurn("next question");
  assert.deepEqual(saved, compacted);
  assert.ok(createInputs[0]?.some((item) => item.type === "compaction"));
  assert.ok(createInputs[0]?.some((item) => item.role === "user" && item.content === "next question"));
  assert.ok(!createInputs[0]?.some((item) => item.content === "old context"));
});

test("automatic compaction runs at the known context threshold before sampling", async () => {
  const calls: string[] = [];
  const inputs: Array<Array<Record<string, unknown>>> = [];
  const agent = new ReactAgent({
    model: "test",
    contextWindow: 100,
    client: {
      responses: {
        async compact(params) {
          calls.push("compact");
          assert.ok((params.input as Array<Record<string, unknown>>).some((item) => item.content === "second"));
          return {
            output: [{ type: "compaction", encrypted_content: "opaque" }],
            usage: { input_tokens: 70, output_tokens: 5, total_tokens: 75 },
          };
        },
        async create(params) {
          calls.push("create");
          inputs.push(params.input as Array<Record<string, unknown>>);
          if (calls.filter((call) => call === "create").length === 1) {
            return {
              id: "first",
              output_text: "first answer",
              output: [],
              usage: { input_tokens: 80, output_tokens: 10, total_tokens: 90 },
            };
          }
          return { id: "second", output_text: "second answer", output: [] };
        },
      },
    },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });

  await agent.runTurn("first");
  await agent.runTurn("second");
  assert.deepEqual(calls, ["create", "compact", "create"]);
  assert.equal(inputs[1]?.[0]?.type, "compaction");
});

test("compaction failures do not enter the ordinary sampling retry loop", async () => {
  let compactCalls = 0;
  let createCalls = 0;
  const agent = new ReactAgent({
    model: "test",
    contextWindow: 100,
    client: {
      responses: {
        async compact() {
          compactCalls += 1;
          const error = new Error("compact unavailable") as Error & { status?: number };
          error.status = 500;
          throw error;
        },
        async create() {
          createCalls += 1;
          return {
            id: `response-${createCalls}`,
            output_text: "done",
            output: [],
            usage: { input_tokens: 80, output_tokens: 10, total_tokens: 90 },
          };
        },
      },
    },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  await agent.runTurn("first");
  await assert.rejects(agent.runTurn("second"), /compact unavailable/);
  assert.equal(compactCalls, 1);
  assert.equal(createCalls, 1);
});

test("resumed missing outputs and thrown tool executors cannot poison subsequent requests", async () => {
  let requests = 0;
  const persisted: Record<string, unknown>[] = [];
  const agent = new ReactAgent({
    model: "test",
    initialHistory: [{ type: "function_call", call_id: "old", name: "bash", arguments: "{}" }],
    client: { responses: { async create(params) {
      const input = params.input as Record<string, unknown>[];
      assert.ok(input.some((item) => item.type === "function_call_output" && item.call_id === "old"));
      if (++requests === 1) return { id: "tool", output_text: "", output: [{ type: "function_call", name: "bash", call_id: "new", arguments: '{"command":"pwd"}' }] };
      assert.ok(input.some((item) => item.call_id === "new" && String(item.output).includes("executor failed")));
      return { id: "done", output_text: "done", output: [] };
    } } },
    io: { async confirmBash() { return true; }, async runBash() { throw new Error("executor failed"); }, writeAssistant() {} },
    async onHistoryAppend(items) { persisted.push(...items); },
  });
  await agent.runTurn("continue");
  await agent.runTurn("again");
  assert.equal(requests, 3);
  assert.ok(persisted.some((item) => item.type === "function_call_output" && item.call_id === "new"));
});

test("cancellation closes pending function calls and the next turn remains usable", async () => {
  const controller = new AbortController();
  let requests = 0;
  const batches: Array<readonly Record<string, unknown>[]> = [];
  const agent = new ReactAgent({
    model: "test",
    client: { responses: { async create(params) {
      requests++;
      if (requests === 1) return { id: "tool", output_text: "", output: [
        { type: "function_call", name: "bash", call_id: "cancel-1", arguments: '{"command":"sleep 60"}' },
        { type: "function_call", name: "bash", call_id: "cancel-2", arguments: '{"command":"echo never"}' },
      ] };
      const history = params.input as Array<Record<string, unknown>>;
      const results = history.filter((entry) => entry.type === "function_call_output");
      assert.equal(results.length, 2);
      assert.ok(results.every((entry) => String(entry.output).includes("cancelled")));
      return { id: "done", output_text: "ready", output: [] };
    } } },
    io: {
      async confirmBash() { return true; },
      async runBash(_command, signal) { assert.equal(signal, controller.signal); controller.abort(); return { ...bashResult("partial"), cancelled: true }; },
      writeAssistant() {},
    },
    async onHistoryAppend(items) { batches.push(items); },
  });
  await assert.rejects(agent.runTurn("run", controller.signal), /abort/i);
  assert.equal(requests, 1);
  assert.equal(batches.flat().filter((item) => item.type === "function_call_output").length, 2);
  await agent.runTurn("continue");
  assert.equal(requests, 2);
});

test("permissions are checked at execution time and changing policy retains agent context", async () => {
  let policy: PermissionPolicy = { mode: "read-only", web: false };
  let ran = 0;
  let requests = 0;
  const outputs: string[] = [];
  const agent = new ReactAgent({
    model: "test",
    client: { responses: { async create(params) {
      requests++;
      if (requests % 2 === 1) return { id: "tool", output_text: "", output: [
        { type: "function_call", name: "bash", arguments: '{"command":"pwd"}', call_id: `bash-${requests}` },
        { type: "function_call", name: "web_search", arguments: '{"query":"test"}', call_id: `web-${requests}` },
      ] };
      const history = params.input as Array<Record<string, unknown>>;
      outputs.push(...history.filter((item) => item.type === "function_call_output").map((item) => String(item.output)));
      if (requests === 4) assert.equal(history.filter((item) => item.role === "user").length, 2);
      return { id: "done", output_text: "done", output: [] };
    } } },
    io: {
      getPermissions: () => policy,
      async confirmBash() { return false; },
      async confirmWeb() { return false; },
      async runBash() { ran++; return bashResult("ok"); },
      writeAssistant() {},
    },
    web: { async search() { throw new Error("Must not search"); }, async fetch() { throw new Error("Must not fetch"); } },
  });
  await agent.runTurn("inspect");
  assert.equal(ran, 0);
  assert.ok(outputs.every((output) => output.includes("denied") || output.includes("rejected")));
  policy = { mode: "full-access", web: false };
  await agent.runTurn("continue");
  assert.equal(ran, 1);
});

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

test("plan mode exposes only read-only and planning tools", async () => {
  let request: Record<string, unknown> | undefined;
  const agent = new ReactAgent({
    client: { responses: { async create(params) { request = params; return { id: "plan", output_text: "planned", output: [] }; } } },
    model: "test",
    io: { async confirmBash() { throw new Error("not allowed"); }, async runBash() { throw new Error("not allowed"); }, writeAssistant() {} },
  });
  await agent.runTurn("make a plan", undefined, { mode: "plan" });
  const names = (request?.tools as Array<{ name: string }>).map((tool) => tool.name);
  assert.ok(names.includes("read_file"));
  assert.ok(names.includes("request_user_input"));
  assert.ok(names.includes("submit_plan"));
  assert.ok(!names.includes("bash"));
  assert.ok(!names.includes("get_goal"));
});

test("plan mode can use enabled web tools without approval", async () => {
  let requests = 0;
  let webApprovals = 0;
  const agent = new ReactAgent({
    client: { responses: { async create() {
      requests += 1;
      return requests === 1
        ? { id: "search", output_text: "", output: [{ type: "function_call", name: "web_search", arguments: '{"query":"TypeScript"}', call_id: "search-1" }] }
        : { id: "done", output_text: "Plan researched.", output: [] };
    } } },
    model: "test",
    io: {
      getPermissions: () => ({ mode: "workspace-write", web: true }),
      async confirmBash() { throw new Error("Bash should not be requested in Plan mode"); },
      async confirmWeb() { webApprovals += 1; return true; },
      async runBash() { throw new Error("Bash should not run in Plan mode"); },
      writeAssistant() {},
    },
    web: {
      async search(query) { return { query, results: [] }; },
      async fetch() { throw new Error("web_fetch should not run"); },
    },
  });

  await agent.runTurn("research the current TypeScript details", undefined, { mode: "plan" });
  assert.equal(webApprovals, 0);
  assert.equal(requests, 2);
});

test("agent loads learned memory once and captures a completed substantive turn", async () => {
  const instructions: string[] = [];
  const prompts: string[] = [];
  const captures: unknown[] = [];
  let loadCount = 0;
  const learnedMemory = {
    async loadPrompt() {
      loadCount += 1;
      return "<learned_memory>Prefer the existing test style.</learned_memory>";
    },
    scheduleCapture(turn: unknown) {
      captures.push(turn);
    },
    async remember() {},
    async status() { return { enabled: true, projectEntries: 0, userEntries: 0, recent: [] }; },
    async setEnabled() {},
    async clear() {},
  };
  const responses = [
    { id: "tool", output_text: "", output: [{ type: "function_call", name: "read_file", call_id: "call-1", arguments: '{"path":"README.md"}' }] },
    { id: "done", output_text: "Completed", output: [] },
    { id: "done-2", output_text: "Completed again", output: [] },
  ];
  const agent = new ReactAgent({
    model: "test",
    workspacePath: "C:\\repo",
    learnedMemory,
    client: { responses: { async create(params) {
      instructions.push(String(params.instructions));
      prompts.push(JSON.stringify(params.input));
      return responses.shift()!;
    } } },
    io: { async confirmBash() { return false; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  await agent.runTurn("inspect the repository");
  await agent.runTurn("continue");
  assert.equal(loadCount, 1);
  assert.equal(captures.length, 2);
  assert.match(instructions[0]!, /Prefer the existing test style/u);
  assert.match(prompts[1]!, /README\.md/u);
  assert.equal((captures[0] as { toolCallCount: number }).toolCallCount, 1);
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
      getPermissions: () => ({ mode: "ask", web: true }),
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
      getPermissions: () => ({ mode: "ask", web: true }),
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

test("agent exposes MCP tools, keeps approval separate, and returns MCP output", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const approvals: string[] = [];
  const calls: string[] = [];
  const responses = [
    {
      id: "mcp-tool",
      output_text: "",
      output: [{
        type: "function_call",
        name: "mcp__calendar__list",
        arguments: '{"day":"today"}',
        call_id: "mcp-1",
      }],
    },
    { id: "mcp-done", output_text: "done", output: [] },
  ];
  const agent = new ReactAgent({
    model: "test",
    client: { responses: { async create(params) {
      requests.push(params);
      return responses.shift()!;
    } } },
    mcp: {
      async ensureReady() {
        return {
          tools: [{ type: "function", name: "mcp__calendar__list", description: "List events", parameters: { type: "object" } }],
          instructions: "Calendar MCP instructions.",
          servers: [],
        };
      },
      toolInfo(name) {
        return name === "mcp__calendar__list"
          ? { callableName: name, serverName: "calendar", toolName: "list" }
          : undefined;
      },
      async call(name, args) {
        calls.push(`${name}:${args}`);
        return JSON.stringify({ content: [{ type: "text", text: "meeting" }] });
      },
    },
    io: {
      getPermissions: () => ({ mode: "workspace-write", web: false }),
      async confirmBash() { return false; },
      async confirmMcp(request) { approvals.push(request); return true; },
      async runBash() { return bashResult(""); },
      writeAssistant() {},
    },
  });

  await agent.runTurn("list my meetings");

  assert.equal(approvals.length, 1);
  assert.match(approvals[0]!, /calendar\/list/u);
  assert.deepEqual(calls, ['mcp__calendar__list:{"day":"today"}']);
  assert.match(String(requests[0]?.instructions), /Calendar MCP instructions/u);
  const tools = requests[0]?.tools as Array<{ name: string }>;
  assert.ok(tools.some((tool) => tool.name === "mcp__calendar__list"));
  assert.match(JSON.stringify(requests[1]?.input), /meeting/u);
});

test("agent progressively loads matching skills and injects explicit skill instructions for one turn", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const reads: string[] = [];
  const responses = [
    {
      id: "skill-tool",
      output_text: "",
      output: [{ type: "function_call", name: "read_skill", arguments: '{"name":"demo"}', call_id: "skill-1" }],
    },
    { id: "skill-done", output_text: "done", output: [] },
  ];
  const agent = new ReactAgent({
    model: "test",
    client: { responses: { async create(params) {
      requests.push(params);
      return responses.shift()!;
    } } },
    skills: {
      async prepareTurn(input) {
        assert.equal(input, "use $demo");
        return {
          skills: [{ name: "demo", description: "Demo tasks", path: "/skills/demo/SKILL.md", directory: "/skills/demo", scope: "user" }],
          errors: [],
          conflictedNames: [],
          instructions: "Available skill: demo.",
          explicitInstructions: "Full explicit demo instructions.",
          explicitNames: ["demo"],
        };
      },
      async read(args) { reads.push(args); return JSON.stringify({ status: "ok", data: { contents: "skill body" } }); },
    },
    io: {
      async confirmBash() { return false; },
      async runBash() { return bashResult(""); },
      writeAssistant() {},
    },
  });

  await agent.runTurn("use $demo");

  assert.deepEqual(reads, ['{"name":"demo"}']);
  assert.match(String(requests[0]?.instructions), /Full explicit demo instructions/u);
  assert.ok((requests[0]?.tools as Array<{ name: string }>).some((tool) => tool.name === "read_skill"));
  assert.match(JSON.stringify(requests[1]?.input), /skill body/u);
});

test("workspace-write searches the web without per-request confirmation", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const toolActivity: string[] = [];
  const webApprovals: string[] = [];
  const responses = [
    {
      id: "response-search",
      output_text: "",
      output: [
        {
          type: "function_call",
          name: "web_search",
          arguments: '{"query":"latest TypeScript release"}',
          call_id: "call-search",
        },
      ],
    },
    { id: "response-final", output_text: "TypeScript was released.", output: [] },
  ];
  const agent = new ReactAgent({
    client: {
      responses: {
        async create(params) {
          requests.push(params);
          const response = responses.shift();
          assert.ok(response);
          return response;
        },
      },
    },
    model: "deepseek-flash",
    io: {
      async confirmBash() {
        throw new Error("Web search must not request Bash confirmation");
      },
      async confirmWeb() {
        webApprovals.push("search");
        return true;
      },
      async runBash() {
        throw new Error("Web search must not run Bash");
      },
      writeAssistant() {},
      writeTool(text) {
        toolActivity.push(text);
      },
    },
    web: {
      async search(query) {
        assert.equal(query, "latest TypeScript release");
        return {
          query,
          results: [
            {
              title: "TypeScript",
              url: "https://www.typescriptlang.org/",
              snippet: "Latest release",
            },
          ],
        };
      },
      async fetch() {
        throw new Error("web_fetch should not run");
      },
    },
  });

  await agent.runTurn("What is the latest TypeScript release?");

  assert.deepEqual(toolActivity, ["Searching the web: latest TypeScript release"]);
  assert.deepEqual(webApprovals, []);
  const tools = requests[0]?.tools as Array<Record<string, unknown>>;
  assert.deepEqual(tools.map((tool) => tool.name), [
    "bash",
    "apply_patch",
    "web_search",
    "web_fetch",
    "read_file",
    "list_directory",
  ]);
  const history = requests[1]?.input as Array<Record<string, unknown>>;
  const toolOutput = history.find((item) => item.type === "function_call_output");
  assert.ok(toolOutput);
  assert.match(String(toolOutput.output), /typescriptlang\.org/u);
});

test("agent returns web failures to the model as tool output", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const responses = [
    {
      id: "response-search",
      output_text: "",
      output: [
        {
          type: "function_call",
          name: "web_search",
          arguments: '{"query":"current news"}',
          call_id: "call-search",
        },
      ],
    },
    { id: "response-final", output_text: "Search is unavailable.", output: [] },
  ];
  const agent = new ReactAgent({
    client: {
      responses: {
        async create(params) {
          requests.push(params);
          const response = responses.shift();
          assert.ok(response);
          return response;
        },
      },
    },
    model: "deepseek-flash",
    io: {
      async confirmBash() {
        return false;
      },
      async confirmWeb() {
        return true;
      },
      async runBash() {
        return bashResult("");
      },
      writeAssistant() {},
    },
    web: {
      async search() {
        throw new Error("network unavailable");
      },
      async fetch() {
        throw new Error("not used");
      },
    },
  });

  await agent.runTurn("search the news");

  const history = requests[1]?.input as Array<Record<string, unknown>>;
  const toolOutput = history.find((item) => item.type === "function_call_output");
  assert.ok(toolOutput);
  assert.match(String(toolOutput.output), /network unavailable/u);
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

test("agent reports usage for every response in a tool loop", async () => {
  const usage: Array<{
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  } | null> = [];
  const responses = [
    {
      id: "response-tool",
      output_text: "checking",
      output: [
        {
          type: "function_call",
          name: "bash",
          arguments: '{"command":"pwd"}',
          call_id: "call-usage",
        },
      ],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    },
    {
      id: "response-final",
      output_text: "done",
      output: [],
      usage: { input_tokens: 150, output_tokens: 30, total_tokens: 180 },
    },
  ];
  const agent = new ReactAgent({
    client: {
      responses: {
        async create() {
          const response = responses.shift();
          assert.ok(response);
          return response;
        },
      },
    },
    model: "deepseek-flash",
    io: {
      async confirmBash() {
        return true;
      },
      async runBash() {
        return bashResult("/repo\n");
      },
      writeAssistant() {},
    },
    async onUsage(sample) {
      usage.push(sample);
    },
  });

  await agent.runTurn("inspect");

  assert.deepEqual(usage, [
    { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    { input_tokens: 150, output_tokens: 30, total_tokens: 180 },
  ]);
});

test("agent sends a stable prompt cache key and reports cached usage details", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const requestOptions: Array<Record<string, unknown> | undefined> = [];
  const usage: Array<unknown> = [];
  const agent = new ReactAgent({
    model: "gpt-5.6",
    promptCacheKey: "everpeace:v2:session:test-key",
    promptCacheOptions: { mode: "implicit", ttl: "30m" },
    client: {
      responses: {
        async create(params, options) {
          requests.push(params);
          requestOptions.push(options as Record<string, unknown> | undefined);
          return {
            id: "response-cache",
            output_text: "done",
            output: [],
            usage: {
              input_tokens: 100,
              output_tokens: 10,
              total_tokens: 110,
              input_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 },
            },
          };
        },
      },
    },
    io: {
      async confirmBash() { return false; },
      async runBash() { return bashResult(""); },
      writeAssistant() {},
    },
    async onUsage(sample) { usage.push(sample); },
  });

  await agent.runTurn("hello");
  assert.equal(requests[0]?.prompt_cache_key, "everpeace:v2:session:test-key");
  assert.deepEqual(requests[0]?.prompt_cache_options, { mode: "implicit", ttl: "30m" });
  assert.equal(requests[0]?.instructions, undefined);
  const requestInput = requests[0]?.input as Array<Record<string, unknown>>;
  assert.equal(requestInput[0]?.role, "developer");
  assert.deepEqual((requestInput[0]?.content as Array<Record<string, unknown>>)[0]?.prompt_cache_breakpoint, { mode: "explicit" });
  assert.deepEqual(requestOptions[0]?.headers, { "session-id": "everpeace:v2:session:test-key" });
  assert.deepEqual(usage, [{
    input_tokens: 100,
    output_tokens: 10,
    total_tokens: 110,
    cached_input_tokens: 80,
    cache_write_input_tokens: 20,
  }]);
});

test("agent resolves the session cache key at request time and reuses it for compaction", async () => {
  let sessionId: string | undefined;
  const calls: Array<{ kind: string; params: Record<string, unknown>; options: Record<string, unknown> | undefined }> = [];
  const agent = new ReactAgent({
    model: "gpt-5.5",
    promptCacheKey: () => sessionId === undefined ? undefined : `everpeace:v2:session:${sessionId}`,
    client: {
      responses: {
        async create(params, options) {
          calls.push({ kind: "create", params, options: options as Record<string, unknown> | undefined });
          return { id: "response-1", output_text: "done", output: [] };
        },
        async compact(params, options) {
          calls.push({ kind: "compact", params, options: options as Record<string, unknown> | undefined });
          return { output: [{ role: "user", content: "retained" }] };
        },
      },
    },
    io: {
      async confirmBash() { return false; },
      async runBash() { return bashResult(""); },
      writeAssistant() {},
    },
  });

  sessionId = "created-after-agent";
  await agent.runTurn("hello");
  await agent.compact();

  assert.equal(calls[0]?.params.prompt_cache_key, "everpeace:v2:session:created-after-agent");
  assert.deepEqual(calls[0]?.options?.headers, { "session-id": "everpeace:v2:session:created-after-agent" });
  assert.equal(calls[1]?.kind, "compact");
  assert.equal(calls[1]?.params.prompt_cache_key, "everpeace:v2:session:created-after-agent");
  assert.deepEqual(calls[1]?.options?.headers, { "session-id": "everpeace:v2:session:created-after-agent" });
});

test("stream requests use the same session cache affinity header", async () => {
  let seenOptions: Record<string, unknown> | undefined;
  const agent = new ReactAgent({
    model: "gpt-5.5",
    promptCacheKey: "everpeace:v2:session:stream",
    client: {
      responses: {
        async create() {
          throw new Error("buffered path should not be used");
        },
        async *stream(_params, options) {
          seenOptions = options as Record<string, unknown> | undefined;
          yield { type: "response.completed", response: { id: "stream-response", output: [], output_text: "done" } };
        },
      },
    },
    io: {
      async confirmBash() { return false; },
      async runBash() { return bashResult(""); },
      writeAssistant() {},
    },
  });

  await agent.runTurn("hello");

  assert.deepEqual(seenOptions?.headers, { "session-id": "everpeace:v2:session:stream" });
});

test("agent falls back once when advanced prompt cache fields are rejected", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const agent = new ReactAgent({
    model: "gpt-5.6",
    promptCacheKey: "everpeace:v2:session:fallback",
    promptCacheOptions: { mode: "implicit", ttl: "30m" },
    client: {
      responses: {
        async create(params) {
          requests.push(params);
          if (params.prompt_cache_options !== undefined) {
            throw { status: 400, message: "Unknown parameter: prompt_cache_options" };
          }
          return { id: "response-1", output_text: "done", output: [] };
        },
      },
    },
    io: {
      async confirmBash() { return false; },
      async runBash() { return bashResult(""); },
      writeAssistant() {},
    },
  });

  await agent.runTurn("hello");

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]?.prompt_cache_options, { mode: "implicit", ttl: "30m" });
  assert.equal(requests[1]?.prompt_cache_options, undefined);
  assert.equal(typeof requests[1]?.instructions, "string");
  assert.equal(requests[1]?.prompt_cache_key, "everpeace:v2:session:fallback");
});

test("agent reports unavailable usage without failing compatible endpoints", async () => {
  const usage: Array<unknown> = [];
  const agent = new ReactAgent({
    client: {
      responses: {
        async create() {
          return { id: "response-1", output_text: "done", output: [] };
        },
      },
    },
    model: "custom-model",
    io: {
      async confirmBash() {
        return false;
      },
      async runBash() {
        return bashResult("");
      },
      writeAssistant() {},
    },
    async onUsage(sample) {
      usage.push(sample);
    },
  });

  await agent.runTurn("hello");

  assert.deepEqual(usage, [null]);
});

test("agent consumes Responses stream deltas and reconstructs tool calls", async () => {
  const deltas: string[] = [];
  const assistants: string[] = [];
  const calls: string[] = [];
  const toolProgress: string[] = [];
  let request = 0;
  const agent = new ReactAgent({
    model: "streaming-test",
    client: {
      responses: {
        async create() { throw new Error("buffered path should not be used"); },
        async *stream() {
          request++;
          if (request === 1) {
            yield { type: "response.output_text.delta", delta: "I will " };
            yield { type: "response.output_text.delta", delta: "inspect." };
            yield { type: "response.output_item.added", output_index: 0, item: { id: "fc-stream", type: "function_call", name: "bash", arguments: "" } };
            yield { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc-stream", delta: '{"command":"pwd"}' };
            yield { type: "response.output_item.done", output_index: 0, item: { type: "function_call", name: "bash", call_id: "stream-call", arguments: '{"command":"pwd"}' } };
          } else {
            yield { type: "response.output_text.delta", delta: "Done" };
          }
          yield { type: "response.completed", response: { id: `response-${request}`, output: request === 1 ? [{ type: "function_call", name: "bash", call_id: "stream-call", arguments: '{"command":"pwd"}' }] : [], output_text: request === 1 ? "I will inspect." : "Done" } };
        },
      },
    },
    io: {
      async confirmBash() { return true; },
      async runBash(command) { calls.push(command); return bashResult("ok"); },
      writeAssistant(text) { assistants.push(text); },
      writeAssistantDelta(text) { deltas.push(text); },
      onToolProgress(event) { toolProgress.push(`${event.phase}:${event.name}:${event.detail ?? ""}`); },
    },
  });
  await agent.runTurn("inspect");
  assert.deepEqual(deltas, ["I will ", "inspect.", "Done"]);
  assert.deepEqual(assistants, ["I will inspect.", "Done"]);
  assert.deepEqual(calls, ["pwd"]);
  assert.ok(toolProgress.some((event) => event.includes('streaming:bash:{"command":"pwd"}')));
});

test("agent falls back to buffered responses only for an explicit stream capability rejection", async () => {
  let streamCalls = 0;
  let createCalls = 0;
  const agent = new ReactAgent({
    model: "stream-fallback-test",
    client: {
      responses: {
        async stream() {
          streamCalls += 1;
          throw Object.assign(new Error("stream is not supported"), {
            status: 400,
            code: "unsupported_parameter",
            param: "stream",
          });
        },
        async create() {
          createCalls += 1;
          return { id: `buffered-${createCalls}`, output_text: "done", output: [] };
        },
      },
    },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });

  await agent.runTurn("first");
  await agent.runTurn("second");
  assert.equal(streamCalls, 1);
  assert.equal(createCalls, 2);
});

test("agent retries a stream interruption without buffered fallback or duplicate tools", async () => {
  let streamCalls = 0;
  const deltas: string[] = [];
  const retries: number[] = [];
  let toolCalls = 0;
  const agent = new ReactAgent({
    model: "stream-retry-test",
    client: {
      responses: {
        async create() { throw new Error("buffered fallback is not allowed"); },
        async *stream() {
          streamCalls += 1;
          yield { type: "response.output_text.delta", delta: "partial" };
          if (streamCalls === 1) {
            throw Object.assign(new Error("connection dropped"), { name: "APIConnectionError" });
          }
          yield { type: "response.completed", response: { id: "complete", output: [], output_text: "complete" } };
        },
      },
    },
    onEvent(event) {
      if (event.type === "retrying") retries.push(event.attempt);
    },
    io: {
      async confirmBash() { return true; },
      async runBash() { toolCalls += 1; return bashResult("unexpected"); },
      writeAssistantDelta(text) { deltas.push(text); },
      writeAssistant() {},
    },
  });

  await agent.runTurn("retry");
  assert.equal(streamCalls, 2);
  assert.deepEqual(retries, [1]);
  assert.deepEqual(deltas, ["partial", "partial"]);
  assert.equal(toolCalls, 0);
});

test("agent rejects a clean stream EOF without response.completed", async () => {
  let streamCalls = 0;
  const retries: number[] = [];
  const agent = new ReactAgent({
    model: "stream-eof-test",
    client: {
      responses: {
        async create() { throw new Error("buffered fallback is not allowed"); },
        async *stream() {
          streamCalls += 1;
          yield { type: "response.output_text.delta", delta: "partial" };
        },
      },
    },
    onEvent(event) {
      if (event.type === "retrying") retries.push(event.attempt);
    },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });

  await assert.rejects(agent.runTurn("eof"), /response\.completed/);
  assert.equal(streamCalls, 3);
  assert.deepEqual(retries, [1, 2]);
});

test("agent compacts once and retries after a context-limit response error", async () => {
  let createCalls = 0;
  let compactCalls = 0;
  const compactEvents: string[] = [];
  const inputs: Array<Array<Record<string, unknown>>> = [];
  const compacted = [{ type: "compaction", encrypted_content: "opaque" }];
  const agent = new ReactAgent({
    model: "context-recovery-test",
    client: {
      responses: {
        async create(params) {
          createCalls += 1;
          inputs.push(params.input as Array<Record<string, unknown>>);
          if (createCalls === 1) {
            throw Object.assign(new Error("maximum context length is 100"), {
              status: 400,
              code: "context_length_exceeded",
            });
          }
          return { id: "recovered", output_text: "recovered", output: [] };
        },
        async compact() {
          compactCalls += 1;
          return { output: compacted, usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } };
        },
      },
    },
    onEvent(event) {
      if (event.type === "compaction_started") compactEvents.push("started");
      if (event.type === "compaction_completed") compactEvents.push("completed");
    },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });

  await agent.runTurn("recover");
  assert.equal(createCalls, 2);
  assert.equal(compactCalls, 1);
  assert.deepEqual(compactEvents, ["started", "completed"]);
  assert.equal(inputs[1]?.[0]?.type, "compaction");
});

test("agent does not compact ordinary bad requests or retry a second context failure", async () => {
  let createCalls = 0;
  let compactCalls = 0;
  const ordinary = new ReactAgent({
    model: "ordinary-error-test",
    client: { responses: {
      async create() {
        throw Object.assign(new Error("invalid request"), { status: 400, code: "invalid_request" });
      },
      async compact() { compactCalls += 1; return { output: [] }; },
    } },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  await assert.rejects(ordinary.runTurn("bad"), /invalid request/);
  assert.equal(compactCalls, 0);

  const repeated = new ReactAgent({
    model: "repeated-context-test",
    client: { responses: {
      async create() {
        createCalls += 1;
        throw Object.assign(new Error("maximum context length"), { status: 400, code: "context_length_exceeded" });
      },
      async compact() { compactCalls += 1; return { output: [{ type: "compaction" }] }; },
    } },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  await assert.rejects(repeated.runTurn("again"), /maximum context length/);
  assert.equal(createCalls, 2);
  assert.equal(compactCalls, 1);
});

test("agent applies guidance by stopping sampling and continuing with durable context", async () => {
  let request = 0;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const inputs: Array<Record<string, unknown>[]> = [];
  const agent = new ReactAgent({
    model: "steering-test",
    client: {
      responses: {
        async create() { throw new Error("buffered path should not be used"); },
        async *stream(params, options) {
          inputs.push(params.input as Record<string, unknown>[]);
          request++;
          if (request === 1) {
            started();
            await new Promise<never>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
            });
          }
          yield { type: "response.completed", response: { id: `response-${request}`, output: [], output_text: "corrected" } };
        },
      },
    },
    io: {
      async confirmBash() { return true; },
      async runBash() { return bashResult(""); },
      writeAssistant() {},
    },
  });
  const turn = agent.runTurn("start");
  await ready;
  assert.equal(agent.requestSteering("use the safer approach"), true);
  await turn;
  assert.ok(inputs[1]?.some((item) => item.role === "user" && item.content === "use the safer approach"));
});

test("guidance submitted before Ctrl+C is checkpointed for the next turn", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let request = 0;
  let nextInput: Record<string, unknown>[] = [];
  const agent = new ReactAgent({
    model: "steering-cancel-test",
    client: {
      responses: {
        async create() { throw new Error("buffered path should not be used"); },
        async *stream(params, options) {
          request++;
          if (request === 1) {
            started();
            await new Promise<never>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
            });
          }
          nextInput = params.input as Record<string, unknown>[];
          yield { type: "response.completed", response: { id: "done", output: [], output_text: "done" } };
        },
      },
    },
    io: {
      async confirmBash() { return true; },
      async runBash() { return bashResult(""); },
      writeAssistant() {},
    },
  });
  const turn = agent.runTurn("start", controller.signal);
  await ready;
  agent.requestSteering("keep the correction");
  controller.abort();
  await assert.rejects(turn, /abort/i);
  await agent.runTurn("continue");
  assert.ok(nextInput.some((item) => item.role === "user" && item.content === "keep the correction"));
});

test("provider stream recovery resumes only after an interrupted response", async () => {
  let streamCalls = 0;
  let recoveryCalls = 0;
  const events: string[] = [];
  const agent = new ReactAgent({
    model: "recovery-test",
    client: {
      responses: {
        async create() { throw new Error("buffered path should not be used"); },
        async *stream() {
          streamCalls += 1;
          yield { id: "event-1", type: "response.output_text.delta", delta: "partial" };
          throw new Error("connection dropped");
        },
        recovery: {
          async resume(_params, state) {
            recoveryCalls += 1;
            assert.equal(state.lastEventId, "event-1");
            return { id: "recovered", output_text: "complete", output: [], status: "completed" };
          },
        },
      },
    },
    streamRecoveryBudget: 1,
    onEvent(event) {
      if (event.type === "stream_recovery_started") events.push("started");
      if (event.type === "stream_recovery_finished") events.push(event.success === false ? "failed" : "finished");
    },
    io: { async confirmBash() { return false; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  await agent.runTurn("resume");
  assert.equal(streamCalls, 1);
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(events, ["started", "finished"]);
});

test("recovery failure consumes its budget and falls back to bounded sampling retry", async () => {
  let streamCalls = 0;
  let recoveryCalls = 0;
  const agent = new ReactAgent({
    model: "recovery-failure-test",
    client: {
      responses: {
        async create() { throw new Error("buffered path should not be used"); },
        async *stream() {
          streamCalls += 1;
          yield { id: `event-${streamCalls}`, type: "response.output_text.delta", delta: "partial" };
          throw new Error("connection dropped");
        },
        recovery: {
          async resume() {
            recoveryCalls += 1;
            throw new Error("resume unavailable");
          },
        },
      },
    },
    streamRecoveryBudget: 1,
    samplingRetryBudget: 1,
    io: { async confirmBash() { return false; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  await assert.rejects(agent.runTurn("resume"), /resume unavailable|response\.completed/);
  assert.equal(recoveryCalls, 1);
  assert.equal(streamCalls, 2);
});

test("parallel tool calls are opt-in and only change the request flag when enabled", async () => {
  const seen: boolean[] = [];
  const makeAgent = (parallelToolCalls?: boolean) => new ReactAgent({
    model: "parallel-flag-test",
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
    client: { responses: {
      async create(params) {
        seen.push(params.parallel_tool_calls as boolean);
        return { id: "done", output_text: "done", output: [] };
      },
    } },
    io: { async confirmBash() { return false; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  await makeAgent().runTurn("serial");
  await makeAgent(true).runTurn("parallel");
  assert.deepEqual(seen, [false, true]);
});
