import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import type { AgentIO } from "../../../src/agent/react-agent.js";
import type {
  RegisteredModel,
  RegisteredModelStatus,
  ResolvedModels,
  StoredModelRegistration,
} from "../../../src/storage/model-registry.js";
import { EverpeaceApp } from "../../../src/tui/app.js";
import type {
  AgentSession,
  TuiDependencies,
  TuiModelRegistry,
} from "../../../src/tui/types.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await tick();
  }
  assert.fail("Timed out waiting for TUI update");
}

function stored(model: RegisteredModel): StoredModelRegistration {
  return {
    id: model.id,
    model_name: model.model_name,
    base_url: model.base_url,
    auth_ref: `model:${model.id}`,
    created_at: "2026-09-14T00:00:00.000Z",
    updated_at: "2026-09-14T00:00:00.000Z",
  };
}

function status(model: RegisteredModel): RegisteredModelStatus {
  return { ...stored(model), credential_status: "ready" };
}

function createFixture(options?: {
  initial?: RegisteredModel[];
  createAgent?: (model: RegisteredModel, io: AgentIO) => AgentSession;
}) {
  let available = options?.initial ?? [];
  const registry: TuiModelRegistry = {
    async resolveAll(): Promise<ResolvedModels> {
      return { available, missing: [] };
    },
    async listStatuses() {
      return available.map(status);
    },
    async registerMany(baseUrl, modelNames, apiKey) {
      const registrations = modelNames.map((modelName, index) => {
        const model: RegisteredModel = {
          id: `registered-${index}`,
          model_name: modelName,
          base_url: baseUrl,
          api_key: apiKey,
        };
        available = [model];
        return stored(model);
      });
      return registrations;
    },
    async removeMany(ids) {
      const removed = available.filter((model) => ids.includes(model.id)).map(stored);
      available = available.filter((model) => !ids.includes(model.id));
      return removed;
    },
  };
  const dependencies: TuiDependencies = {
    registry,
    version: "0.1.10",
    workspacePath: "C:\\workspace",
    async listModels() {
      return ["deepseek-flash"];
    },
    createAgent:
      options?.createAgent ??
      ((_model, io) => ({
        async runTurn(input) {
          io.writeAssistant(`echo: ${input}`);
        },
      })),
    async runBash() {
      return { stdout: "ok\n", stderr: "", exitCode: 0, signal: null };
    },
    async runTerminalCommand() {
      return { stdout: "", stderr: "", exitCode: 0, signal: null };
    },
  };
  return { dependencies, registry };
}

test("TUI accepts chat and renders the assistant response", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onClearOutput={() => undefined}
    />,
  );

  await tick();
  view.stdin.write("你好");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("echo: 你好"));

  const frame = view.lastFrame() ?? "";
  assert.match(frame, /you\s+你好/);
  assert.match(frame, /assistant\s+echo: 你好/);
  assert.doesNotMatch(frame, /https:\/\/api\.deepseek\.com/);
  assert.doesNotMatch(frame, /当前模型|登录状态/);
  assert.equal(frame.match(/deepseek-flash/g)?.length, 2);
  assert.match(frame, /model: deepseek-flash\s+\/model to change/);
  assert.match(frame, /directory: C:\\workspace/);
  assert.match(frame, /C:\\workspace/);
  assert.doesNotMatch(frame, /Enter 发送|终端命令|命令菜单/);
  assert.match(frame, /╭.*╮/);
  assert.match(frame, /╰.*╯/);
  assert.match(frame, /Ask Everpeace to do anything/);
  const frameLines = frame.split("\n");
  const promptInput = frameLines.findIndex((line) => line.includes("everpeace ❯"));
  const promptTop = promptInput - 1;
  const promptBottom = promptInput + 1;
  assert.match(frameLines[promptTop] ?? "", /^╭/);
  assert.match(frameLines[promptBottom] ?? "", /^╰/);
  assert.equal(promptBottom - promptTop, 2);
  view.unmount();
});

test("/login masks the API Key, registers one model, and activates it", async () => {
  const fixture = createFixture();
  const seenKeys: string[] = [];
  fixture.dependencies.listModels = async (baseUrl, apiKey) => {
    assert.equal(baseUrl, "https://api.deepseek.com");
    seenKeys.push(apiKey);
    return ["deepseek-flash"];
  };
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [], missing: [] }}
      onClearOutput={() => undefined}
    />,
  );

  await tick();
  view.stdin.write("/login");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("模型登录"));
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("API Key"));
  await tick();
  view.stdin.write("sk-tui-secret");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("deepseek-flash"));
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("已登录并启用"));

  assert.deepEqual(seenKeys, ["sk-tui-secret"]);
  assert.doesNotMatch(view.frames.join("\n"), /sk-tui-secret/);
  assert.doesNotMatch(view.frames.join("\n"), /https:\/\/api\.deepseek\.com/);
  assert.match(view.lastFrame() ?? "", /deepseek-flash/);
  view.unmount();
});

test("model-requested Bash waits for confirmation", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  let ranBash = false;
  const fixture = createFixture({
    initial: [model],
    createAgent: (_model, io) => ({
      async runTurn() {
        if (await io.confirmBash("pwd")) {
          await io.runBash("pwd");
          io.writeAssistant("done");
        }
      },
    }),
  });
  fixture.dependencies.runBash = async () => {
    ranBash = true;
    return { stdout: "repo\n", stderr: "", exitCode: 0, signal: null };
  };
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onClearOutput={() => undefined}
    />,
  );

  await tick();
  view.stdin.write("run pwd");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("是否执行"));
  assert.equal(ranBash, false);
  view.stdin.write("y");
  await waitFor(() => (view.lastFrame() ?? "").includes("done"));

  assert.equal(ranBash, true);
  assert.match(view.lastFrame() ?? "", /Bash completed successfully/);
  view.unmount();
});

test("direct commands use the native terminal runner", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  let directCommand: string | undefined;
  fixture.dependencies.runTerminalCommand = async (command) => {
    directCommand = command;
    return { stdout: "NAME    SIZE\nfile-a  10", stderr: "", exitCode: 0, signal: null };
  };
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onClearOutput={() => undefined}
    />,
  );

  await tick();
  view.stdin.write("!ls");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Command completed successfully"));

  assert.equal(directCommand, "ls");
  assert.match(view.lastFrame() ?? "", /NAME    SIZE\nfile-a  10/);
  view.unmount();
});

test("startup model picker activates the selected registered model", async () => {
  const models: RegisteredModel[] = [
    {
      id: "model-a",
      model_name: "deepseek-flash",
      base_url: "https://api.deepseek.com",
      api_key: "secret-a",
    },
    {
      id: "model-b",
      model_name: "deepseek-v4-pro",
      base_url: "https://api.deepseek.com",
      api_key: "secret-b",
    },
  ];
  const fixture = createFixture({ initial: models });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: models, missing: [] }}
      onClearOutput={() => undefined}
    />,
  );

  await tick();
  assert.match(view.lastFrame() ?? "", /选择本次会话模型/);
  view.stdin.write("\u001B[B");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("对话上下文已重置"));

  assert.match(view.lastFrame() ?? "", /对话上下文已重置/);
  assert.match(view.lastFrame() ?? "", /deepseek-v4-pro/);
  view.unmount();
});

test("/logout removes the active model and returns to logged-out chat", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onClearOutput={() => undefined}
    />,
  );

  await tick();
  view.stdin.write("/logout");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("注销模型"));
  await tick();
  view.stdin.write(" ");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("删除 1 个模型"));
  await tick();
  view.stdin.write("y");
  await waitFor(() => (view.lastFrame() ?? "").includes("已删除 1 个模型"));

  assert.match(view.lastFrame() ?? "", /未选择模型/);
  view.unmount();
});

test("/clear resets the agent session and clears rendered output", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  let createdAgents = 0;
  let clearCalls = 0;
  const fixture = createFixture({
    initial: [model],
    createAgent: () => {
      createdAgents += 1;
      return { async runTurn() {} };
    },
  });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onClearOutput={() => {
        clearCalls += 1;
      }}
    />,
  );

  await tick();
  assert.equal(createdAgents, 1);
  view.stdin.write("/clear");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => createdAgents === 2);

  assert.equal(clearCalls, 1);
  view.unmount();
});
