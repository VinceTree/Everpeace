import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadProjectContext } from "../../../src/agent/project-context.js";
import { ReactAgent } from "../../../src/agent/react-agent.js";

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

test("agent injects refreshed project context into the step instructions", async () => {
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
    assert.match(String(requests[0]?.instructions), /Run the repository checks/u);
    assert.match(String(requests[0]?.instructions), /personal software-development agent/u);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
