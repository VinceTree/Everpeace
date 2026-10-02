import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentIO } from "../../../src/agent/react-agent.js";
import { defaultModelRequestSettings, resolveProviderCapabilities } from "../../../src/providers/capabilities.js";
import type { ProviderRuntime } from "../../../src/providers/openai-compatible.js";
import { createProductionAgent, createProductionWorkflowAgentIO } from "../../../src/runtime/production.js";
import { SessionStore } from "../../../src/storage/session-store.js";
import { CodingWorkflowRuntime } from "../../../src/workflow/runtime.js";

function fakeProvider(text = "done"): ProviderRuntime {
  const capabilities = resolveProviderCapabilities("https://compatible.invalid/v1", "offline");
  return {
    sdk: {} as ProviderRuntime["sdk"],
    capabilities,
    settings: defaultModelRequestSettings(capabilities),
    responses: {
      async create() { throw new Error("buffered provider path should not be used"); },
      async stream() {
        return (async function* () {
          yield {
            type: "response.completed",
            response: {
              id: "offline-response",
              status: "completed",
              output_text: text,
              output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
              usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
            },
          };
        })();
      },
    },
  };
}

const io: AgentIO = {
  async confirmBash() { return false; },
  async runBash() { return { stdout: "", stderr: "", exitCode: 0, signal: null }; },
  writeAssistant() {},
};

test("production agent resolves a session lazily and persists the shared context", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-production-runtime-"));
  const workspacePath = path.join(root, "workspace");
  await fs.mkdir(workspacePath);
  const sessionStore = new SessionStore({ directory: path.join(root, "sessions") });
  let sessionId: string | undefined;
  const handle = createProductionAgent({
    model: { id: "offline", model_name: "offline", base_url: "https://compatible.invalid/v1", api_key: "fixture" },
    workspacePath,
    io: { ...io, getSessionId: () => sessionId },
    sessionStore,
    sessionId: () => sessionId,
    providerRuntime: fakeProvider("factory complete"),
    skills: null,
    mcp: null,
    learnedMemoryStore: null,
    codeNavigation: null,
    restore: {
      async onHistoryAppend(items) {
        assert.ok(sessionId);
        await sessionStore.appendContext(sessionId, items);
      },
      async onUsage(usage) {
        assert.ok(sessionId);
        await sessionStore.appendUsage(sessionId, usage);
      },
    },
  });
  try {
    const session = await sessionStore.create({
      title: "headless task",
      titlePending: false,
      workspacePath,
      model: { id: "offline", model_name: "offline", base_url: "https://compatible.invalid/v1" },
    });
    sessionId = session.id;
    await handle.agent.runTurn("continue after session creation");
    const loaded = await sessionStore.load(session.id);
    assert.match(JSON.stringify(loaded.context), /continue after session creation/u);
    assert.match(JSON.stringify(loaded.context), /factory complete/u);
    assert.equal(loaded.usage.input_tokens, 2);
    assert.equal(loaded.usage.output_tokens, 1);
  } finally {
    await handle.dispose();
    await handle.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("production factory exposes owned skill roots and applies a non-capturing Memory override", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-production-services-"));
  const workspacePath = path.join(root, "workspace");
  await fs.mkdir(workspacePath);
  const sessionStore = new SessionStore({ directory: path.join(root, "sessions") });
  const handle = createProductionAgent({
    model: { id: "offline", model_name: "offline", base_url: "https://compatible.invalid/v1", api_key: "fixture" },
    workspacePath,
    io,
    sessionStore,
    sessionId: () => undefined,
    providerRuntime: fakeProvider(),
    mcp: null,
    codeNavigation: null,
    learnedMemoryPolicy: { readExisting: true, captureFuture: false },
    memoryIdleDelayMs: 60_000,
  });
  try {
    assert.ok(handle.skills);
    assert.ok(handle.readableRoots().every((item) => path.isAbsolute(item)));
    assert.deepEqual(handle.learnedMemory?.getPolicy?.(), { readExisting: true, captureFuture: false });
  } finally {
    await handle.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("production workflow IO shares patch tracking, shell observation, and host interaction", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-production-io-"));
  const workflow = new CodingWorkflowRuntime({ workspacePath: root });
  await workflow.beginTurn();
  const commands: string[] = [];
  const approvals: string[] = [];
  const agentIO = createProductionWorkflowAgentIO({
    workspacePath: root,
    policy: () => ({ mode: "workspace-write", web: false, shellNetwork: "deny" }),
    workflow,
    execute: async (command) => {
      commands.push(command);
      return { stdout: "ok", stderr: "", exitCode: 0, signal: null };
    },
    interaction: {
      async confirm(_kind, tool, prompt) {
        approvals.push(`${tool}:${prompt}`);
        return tool === "bash";
      },
    },
  });
  try {
    assert.equal(await agentIO.confirmBash("git status"), true);
    assert.equal(await agentIO.confirmPatch?.("create fixture"), false);
    assert.deepEqual(approvals, ["bash:git status", "patch:create fixture"]);
    assert.equal((await agentIO.runBash("git status")).stdout, "ok");
    assert.deepEqual(commands, ["git status"]);

    const operations = [{ path: "created.txt", action: "create" as const, content: "created\n" }];
    const preview = await agentIO.previewPatch?.(operations);
    assert.equal(preview?.status, "ready");
    const applied = await agentIO.runApplyPatch?.(operations);
    assert.equal(applied?.status, "applied");
    assert.equal(await fs.readFile(path.join(root, "created.txt"), "utf8"), "created\n");
    assert.equal(workflow.state.pending_verification, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
