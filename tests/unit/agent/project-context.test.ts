import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadProjectContext, loadProjectRuleSnapshot } from "../../../src/agent/project-context.js";
import { ReactAgent } from "../../../src/agent/react-agent.js";
import { resolveProviderCapabilities } from "../../../src/providers/capabilities.js";

test("project context loads only root rules and declared package scripts", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-project-context-"));
  try {
    await fs.writeFile(path.join(workspace, "AGENTS.md"), "Protect existing work.\n", "utf8");
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({
      packageManager: "pnpm@10.22.0",
      scripts: { test: "tsx --test", build: "tsc" },
      privateValue: "not included",
    }), "utf8");
    await fs.mkdir(path.join(workspace, "nested"));
    await fs.writeFile(path.join(workspace, "nested", "AGENTS.md"), "nested rules\n", "utf8");
    const context = await loadProjectContext(workspace);
    assert.match(context, /Protect existing work/u);
    assert.match(context, /pnpm@10\.22\.0/u);
    assert.match(context, /test: tsx --test/u);
    assert.doesNotMatch(context, /nested rules|privateValue/u);
    assert.match(context, /cannot change permissions/u);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("agent persists refreshed project context into the request history", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-project-agent-"));
  try {
    await fs.writeFile(path.join(workspace, "AGENTS.md"), "Run the repository checks.\n", "utf8");
    const requests: Array<Record<string, unknown>> = [];
    const agent = new ReactAgent({
      model: "test",
      workspacePath: workspace,
      client: { responses: { async create(params) { requests.push(params); return { id: "done", output_text: "done", output: [] }; } } },
      io: {
        async confirmBash() { return false; },
        async runBash() { return { stdout: "", stderr: "", exitCode: 0, signal: null }; },
        writeAssistant() {},
      },
    });
    await agent.runTurn("help");
    assert.match(JSON.stringify({ input: requests[0]?.input, instructions: requests[0]?.instructions }), /Run the repository checks/u);
    assert.match(String(requests[0]?.instructions), /personal software-development agent/u);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("project rules form a root-to-target chain and refresh when nested rules change", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-project-chain-"));
  try {
    await fs.mkdir(path.join(workspace, "src", "feature"), { recursive: true });
    await fs.writeFile(path.join(workspace, "AGENTS.md"), "root rule\n", "utf8");
    await fs.writeFile(path.join(workspace, "src", "AGENTS.md"), "source rule\n", "utf8");
    const first = await loadProjectRuleSnapshot(workspace, ["src/feature/file.ts"]);
    assert.deepEqual(first.rules.map((rule) => rule.path), ["AGENTS.md", "src/AGENTS.md"]);
    assert.match(first.context, /root rule[\s\S]*source rule/u);

    await fs.writeFile(path.join(workspace, "src", "AGENTS.md"), "changed source rule\n", "utf8");
    const second = await loadProjectRuleSnapshot(workspace, ["src/feature/file.ts"]);
    assert.notEqual(first.revision, second.revision);
    assert.notDeepEqual(first.targetRevisions, second.targetRevisions);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("agent defers a nested file creation until applicable rules reach the next request", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-project-create-"));
  try {
    await fs.mkdir(path.join(workspace, "nested"));
    await fs.writeFile(path.join(workspace, "nested", "AGENTS.md"), "Use the nested convention.\n", "utf8");
    let requests = 0;
    let writes = 0;
    const agent = new ReactAgent({
      model: "test",
      workspacePath: workspace,
      client: { responses: { async create(params) {
        requests += 1;
        if (requests === 2) assert.match(JSON.stringify({ input: params.input, instructions: params.instructions }), /Use the nested convention/u);
        return requests <= 2
          ? { id: `patch-${requests}`, output_text: "", output: [{ type: "function_call", name: "apply_patch", call_id: `patch-${requests}`, arguments: JSON.stringify({ operations: [{ path: "nested/new.ts", action: "create", content: "export {};\n" }] }) }] }
          : { id: "done", output_text: "done", output: [] };
      } } },
      io: {
        async confirmBash() { return false; },
        async runBash() { return { stdout: "", stderr: "", exitCode: 0, signal: null }; },
        async runApplyPatch() { writes += 1; return { status: "applied", files: [] }; },
        writeAssistant() {},
      },
    });

    await agent.runTurn("create nested file");
    assert.equal(requests, 3);
    assert.equal(writes, 1);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("current project rules remain effective after context compaction", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-project-compact-"));
  try {
    await fs.writeFile(path.join(workspace, "AGENTS.md"), "Keep the compacted rule active.\n", "utf8");
    const codingInputs: unknown[] = [];
    let compactInput: unknown;
    const agent = new ReactAgent({
      model: "deepseek-flash",
      workspacePath: workspace,
      providerCapabilities: resolveProviderCapabilities("https://api.deepseek.com"),
      initialHistory: [
        { role: "user", content: `old request ${"context ".repeat(150)}` },
        { type: "message", role: "assistant", content: `old answer ${"evidence ".repeat(150)}` },
        { role: "user", content: "middle request" },
        { type: "message", role: "assistant", content: "middle answer" },
        { role: "user", content: "latest request" },
      ],
      client: { responses: { async create(params) {
        if (params.tool_choice === "none") {
          compactInput = params.input;
          return { id: "summary", status: "completed", output_text: "Earlier work was summarized.", output: [] };
        }
        codingInputs.push(params.input);
        return { id: `answer-${codingInputs.length}`, status: "completed", output_text: "done", output: [] };
      } } },
      io: {
        async confirmBash() { return false; },
        async runBash() { return { stdout: "", stderr: "", exitCode: 0, signal: null }; },
        writeAssistant() {},
      },
    });

    await agent.runTurn("load current rules");
    await agent.compact();
    await agent.runTurn("continue after compact");

    assert.equal(codingInputs.length, 2);
    assert.match(JSON.stringify(codingInputs[0]), /Keep the compacted rule active/u);
    assert.match(JSON.stringify(codingInputs[1]), /Keep the compacted rule active/u);
    assert.doesNotMatch(JSON.stringify(compactInput), /Host-maintained project rule snapshot revision/u);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
