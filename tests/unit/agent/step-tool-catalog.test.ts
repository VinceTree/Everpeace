import assert from "node:assert/strict";
import { test } from "node:test";
import { StepToolCatalog } from "../../../src/agent/step-tool-catalog.js";

function mcpFixture(name = "mcp__fixture__read") {
  const definition = {
    type: "function" as const, name, description: "original",
    parameters: { type: "object", properties: { query: { type: "string" } } },
  };
  const info = {
    callableName: name, serverName: "fixture", toolName: "read", binding: "binding-1",
    annotations: { readOnlyHint: true, idempotentHint: true },
  };
  const metadata = new Map([[name, info]]);
  return { definition, info, metadata };
}

test("Plan advertises inspection and review while excluding all execution capabilities", () => {
  const { definition, metadata } = mcpFixture();
  const catalog = new StepToolCatalog({
    mode: "plan", question: true, planReview: true, taskProgress: true,
    navigation: true, history: true, goals: true, memory: true, skills: true,
    mcp: { tools: [definition] }, mcpToolInfo: metadata,
  });
  for (const name of ["read_file", "project_map", "web_search", "workspace_status", "session_search", "code_navigation", "memory_lookup", "read_skill", "request_user_input", "submit_plan"]) {
    assert.equal(catalog.has(name), true, name);
  }
  for (const name of ["bash", "start_background", "stop_background", "apply_patch", "create_goal", "update_goal", "update_plan", definition.name]) {
    assert.equal(catalog.has(name), false, name);
    assert.equal(catalog.capabilities(name), undefined, name);
    assert.equal(catalog.mcpTool(name), undefined, name);
  }
});

test("optional host capabilities are absent until explicitly available", () => {
  const unavailable = new StepToolCatalog({ mode: "default" });
  const available = new StepToolCatalog({ mode: "default", question: true, planReview: true, taskProgress: true, navigation: true, history: true, goals: true, memory: true, skills: true });
  for (const name of ["request_user_input", "update_plan", "code_navigation", "session_search", "create_goal", "memory_lookup", "read_skill"]) {
    assert.equal(unavailable.has(name), false, name);
    assert.equal(unavailable.capabilities(name), undefined, name);
    assert.equal(available.has(name), true, name);
  }
  assert.equal(available.has("submit_plan"), false);
  assert.equal(unavailable.has("bash"), true);
  assert.equal(unavailable.has("apply_patch"), true);
});

test("a catalog owns nested definitions and freezes them against caller mutation", () => {
  const { definition } = mcpFixture();
  const catalog = new StepToolCatalog({ mode: "default", mcp: { tools: [definition] } });
  definition.description = "source changed";
  definition.parameters.properties.query.type = "number";
  const captured = catalog.definitions.find((tool) => tool.name === definition.name);
  assert.ok(captured);
  assert.equal(captured.description, "original");
  assert.deepEqual(captured.parameters, { type: "object", properties: { query: { type: "string" } } });
  assert.equal(Reflect.set(captured, "name", "injected"), false);
  assert.equal(Reflect.set(captured.parameters as object, "properties", {}), false);
  assert.equal(Reflect.set(catalog.definitions, "0", { name: "injected" }), false);
  assert.equal(catalog.has("injected"), false);
  assert.equal(catalog.has(definition.name), true);
});

test("bindings and annotations remain paired with the captured advertised tools", () => {
  const { definition, info, metadata } = mcpFixture();
  metadata.set("unadvertised", { ...info, callableName: "unadvertised" });
  const catalog = new StepToolCatalog({ mode: "default", mcp: { tools: [definition] }, mcpToolInfo: metadata });
  info.binding = "binding-2";
  info.annotations.readOnlyHint = false;
  metadata.clear();
  assert.equal(catalog.mcpTool(definition.name)?.binding, "binding-1");
  assert.equal(catalog.mcpTool(definition.name)?.annotations?.readOnlyHint, true);
  assert.equal(catalog.mcpTool("unadvertised"), undefined);
  assert.equal(Reflect.set(catalog.mcpTool(definition.name)!, "binding", "forged"), false);
});

test("only advertised local reads receive parallel capability and LSP stays serialized", () => {
  const catalog = new StepToolCatalog({ mode: "default", navigation: true, history: true, skills: true, memory: true });
  for (const name of ["read_file", "list_directory", "project_map", "read_workspace_change", "read_tool_output", "session_search", "read_skill"]) {
    assert.deepEqual(catalog.capabilities(name), { readOnly: true, idempotent: true, parallelSafe: true, resourceKeys: [] }, name);
  }
  assert.deepEqual(catalog.capabilities("code_navigation"), { readOnly: true, idempotent: true, parallelSafe: false, resourceKeys: ["typescript-lsp"] });
  for (const name of ["bash", "apply_patch", "web_search", "memory_lookup", "request_user_input", "invented_read"]) {
    assert.equal(catalog.capabilities(name), undefined, name);
  }
  const first = catalog.capabilities("read_file")!;
  first.parallelSafe = false;
  Reflect.set(first.resourceKeys, "0", "caller-state");
  assert.deepEqual(catalog.capabilities("read_file"), { readOnly: true, idempotent: true, parallelSafe: true, resourceKeys: [] });
});

test("MCP hints and a builtin-shaped MCP name cannot grant local parallel capability", () => {
  for (const name of ["mcp__fixture__read", "read_file"]) {
    const { definition, metadata } = mcpFixture(name);
    const catalog = new StepToolCatalog({ mode: "default", mcp: { tools: [definition] }, mcpToolInfo: metadata });
    assert.equal(catalog.has(name), true);
    assert.equal(catalog.capabilities(name), undefined);
    assert.equal(catalog.mcpTool(name)?.binding, "binding-1");
  }
});
