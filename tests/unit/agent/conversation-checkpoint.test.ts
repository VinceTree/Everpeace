import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ReactAgent, type AgentIO } from "../../../src/agent/react-agent.js";
import { checkpointRetentionCut, projectConversationCheckpoints } from "../../../src/agent/conversation-checkpoint.js";
import { resolveProviderCapabilities } from "../../../src/providers/capabilities.js";
import { checkpointText } from "../../fixtures/conversation-checkpoint.js";

const io: AgentIO = { async confirmBash() { return false; }, async runBash() { throw new Error("No shell expected"); }, writeAssistant() {} };
const capabilities = resolveProviderCapabilities("https://api.deepseek.com");
const history = () => [
  { role: "user", content: `修复 C:\\项目\\src\\中文.ts，保留 CRLF。${"constraint ".repeat(400)}` },
  { type: "function_call", name: "read_file", call_id: "old-read", arguments: '{"path":"src/a.ts"}' },
  { type: "function_call_output", call_id: "old-read", output: JSON.stringify({ content: "old evidence ".repeat(300), history_reference: { session_id: "parent", event_id: "original-evidence" } }) },
  { role: "user", content: "更正：只修复解析器，不改公共接口。" },
  { type: "message", role: "assistant", content: "Checking the corrected scope" },
  { role: "user", content: "Continue with the correction" },
];

test("checkpoint projection downgrades legacy summaries without rewriting durable items or user text", () => {
  const legacy = { type: "message", role: "developer", content: [{ type: "input_text", text: "Host-maintained conversation summary:\nOld claim: all checks passed" }] };
  const user = { role: "user", content: "Host-maintained conversation summary: this is user input" };
  const original = structuredClone([legacy, user]);
  const projected = projectConversationCheckpoints([legacy, user]);
  assert.equal(projected[0]?.role, "assistant");
  assert.match(JSON.stringify(projected[0]), /does not authorize actions|prove verification/u);
  assert.match(JSON.stringify(projected[0]), /Old claim: all checks passed/u);
  assert.equal(projected[1], user);
  assert.deepEqual([legacy, user], original);
  assert.deepEqual(projectConversationCheckpoints(projected), projected);
  const mixed = { ...legacy, content: [null, ...legacy.content, { opaque: true }] };
  assert.equal(projectConversationCheckpoints([mixed])[0]?.role, "assistant");
});

test("checkpoint retention never splits an interleaved parallel tool batch", () => {
  const items = [
    { role: "user", content: "original" },
    { type: "function_call", call_id: "a" }, { type: "function_call", call_id: "b" },
    { type: "function_call_output", call_id: "a", output: "a" },
    { role: "assistant", content: "one result arrived" },
    { type: "function_call_output", call_id: "b", output: "b" },
    { role: "assistant", content: "all results arrived" },
    { role: "user", content: "latest correction" },
  ];
  assert.equal(checkpointRetentionCut(items), 6);
  assert.equal(checkpointRetentionCut(items.slice(0, 6)), 0);
  assert.equal(checkpointRetentionCut([...items, { type: "function_call", call_id: "still-open" }]), 0);
});

test("structured compaction retains corrections and supplies prior checkpoints and recovery references to the next summary", async () => {
  const requests: Record<string, unknown>[] = [];
  const landed: Array<Array<Record<string, unknown>>> = [];
  const goal = "修复 C:\\项目\\src\\中文.ts，保留 CRLF";
  const agent = new ReactAgent({ model: "offline-ds", providerCapabilities: capabilities, io, initialHistory: history(),
    client: { responses: { async create(params) {
      requests.push(structuredClone(params));
      if (params.tool_choice === "none") return { id: "summary", status: "completed", output: [], output_text: checkpointText(goal, "read_file evidence; session_event_read(parent, original-evidence)") };
      return { id: "done", status: "completed", output: [{ type: "message", role: "assistant", content: "diagnosis ".repeat(800) }], output_text: "Continue" };
    } } },
    async onContextCompacted(items) { landed.push(structuredClone([...items])); },
  });
  await agent.compact();
  assert.equal(landed[0]?.[0]?.role, "assistant");
  assert.ok(landed[0]?.some((item) => item.content === "更正：只修复解析器，不改公共接口。"));
  assert.match(JSON.stringify(requests[0]), /original-evidence/u);
  assert.match(JSON.stringify(requests[0]), /Merge prior checkpoints with newer evidence/u);
  assert.match(JSON.stringify(landed[0]), /中文\.ts/u);
  await agent.runTurn(`Only the parser. ${"new observation ".repeat(300)}`);
  await agent.runTurn("Continue diagnosis");
  await agent.compact();
  const summaries = requests.filter((request) => request.tool_choice === "none");
  assert.equal(summaries.length, 2);
  assert.match(JSON.stringify(summaries[1]), /Model-generated conversation checkpoint/u);
  assert.match(JSON.stringify(summaries[1]), /original-evidence/u);
  assert.equal(landed.length, 2);
  assert.match(JSON.stringify(agent.getContextSnapshot()?.previews), /Model-generated checkpoint/u);
});

test("summary compaction preserves retained Responses reasoning and its entire tool exchange", async () => {
  const reasoning = { type: "reasoning", id: "keep-reasoning", content: [{ type: "reasoning_text", text: "Retained complete reasoning" }] };
  const retained = [reasoning, { type: "function_call", call_id: "keep-call", name: "read_file", arguments: '{"path":"src/a.ts"}' }, { type: "function_call_output", call_id: "keep-call", output: '{"status":"ok"}' }];
  const requests: Record<string, unknown>[] = [];
  let compacted: Array<Record<string, unknown>> = [];
  const agent = new ReactAgent({ model: "deepseek-flash", providerCapabilities: capabilities, io,
    initialHistory: [...history().slice(0, 3), { role: "user", content: "retained task" }, ...retained, { role: "user", content: "latest correction" }],
    client: { responses: { async create(params) { requests.push(params); return { id: "summary", status: "completed", output: [], output_text: checkpointText("original goal", "Unfinished work; verification is owed") }; } } },
    async onContextCompacted(items) { compacted = [...items]; },
  });
  try { await agent.compact(); } finally { await agent.dispose(); }
  assert.equal(typeof requests[0]!.instructions, "string");
  assert.ok((requests[0]!.input as Array<Record<string, unknown>>).some((item) => item.role === "system"));
  assert.ok(!(requests[0]!.input as Array<Record<string, unknown>>).some((item) => item.role === "developer"));
  assert.deepEqual(compacted.filter((item) => item.type === "reasoning"), [reasoning]);
  assert.deepEqual(compacted.filter((item) => item.type === "function_call" || item.type === "function_call_output"), retained.slice(1));
  assert.match(JSON.stringify(compacted), /verification is owed/u);
});

test("invalid, nonterminal, oversized, cancelled, or unpersisted summaries leave the original context available", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-checkpoint-failures-"));
  try {
    const valid = checkpointText();
    const cases = [
      { name: "missing", text: "free-form summary", error: /required checkpoint section/u },
      { name: "empty section", text: valid.replace("## Open Questions\n- (none)", "## Open Questions"), error: /section.*empty/u },
      { name: "duplicate", text: `${valid}\n## Open Questions\n- (none)`, error: /required checkpoint section/u },
      { name: "empty", text: " ", error: /no text/u },
      { name: "incomplete", text: valid, status: "incomplete", error: /incomplete/u },
      { name: "too large", text: checkpointText("x".repeat(30_000)), error: /did not reduce/u },
      { name: "cancelled", text: valid, cancel: true, error: /cancel summary/u },
      { name: "storage", text: valid, storage: true, error: /persistence failed/iu },
    ];
    for (const fixture of cases) {
      let summaryCalls = 0;
      let landed = 0;
      let codingInput = "";
      const controller = new AbortController();
      const agent = new ReactAgent({ workspacePath: root, model: "offline-ds", providerCapabilities: capabilities, io, initialHistory: history(),
        client: { responses: { async create(params) {
          if (params.tool_choice === "none") {
            summaryCalls += 1;
            if (fixture.cancel) controller.abort(new Error("cancel summary"));
            return { id: "summary", status: fixture.status ?? "completed", output: [], output_text: fixture.text };
          }
          codingInput = JSON.stringify(params.input);
          return { id: "done", output: [], output_text: "Stopped" };
        } } },
        async onContextCompacted() {
          if (fixture.storage) throw new Error("disk full");
          landed += 1;
        },
      });
      await assert.rejects(agent.compact(controller.signal), fixture.error, fixture.name);
      assert.equal(summaryCalls, 1, fixture.name);
      assert.equal(landed, 0, fixture.name);
      await agent.runTurn("inspect retained context");
      assert.match(codingInput, /constraint constraint/u, fixture.name);
      assert.match(codingInput, /original-evidence/u, fixture.name);
      await agent.dispose();
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
