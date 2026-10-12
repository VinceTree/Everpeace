import assert from "node:assert/strict";
import { createDefaultTuiDependencies } from "../../src/tui/app/dependencies.js";

if (!process.env.EVERPEACE_AUXILIARY_TEST_ROOT) throw new Error("An isolated auxiliary fixture root is required");
const model = { id: "offline", model_name: "deepseek-v4-flash", base_url: "https://api.deepseek.com", api_key: "fixture" };
const dependencies = createDefaultTuiDependencies({
  async resolveAll() { return { available: [model], missing: [] }; }, async listStatuses() { return []; },
  async registerMany() { throw new Error("Unexpected registration"); }, async removeMany() { throw new Error("Unexpected removal"); },
});
const skill = "---\nname: offline-test\ndescription: Verify a local test change when asked to repair Node code.\n---\n\nRead the relevant implementation and run the current checks.\n";
const outputs = ["First title", "Second title", skill, skill,
  JSON.stringify({ entries: [{ scope: "user", kind: "preference", lesson: "Use pnpm", applyWhen: "When working in Node projects" }] }),
  "Incomplete title", "After incomplete", "", "After failed request"];
const limits = [64, 64, 4_096, 4_096, 800, 64, 64, 4_096, 64];
const originalFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async (input, options) => {
  const request = input instanceof Request ? input.clone() : new Request(input, options);
  assert.equal(new URL(request.url).hostname, "api.deepseek.com");
  const params = await request.json() as Record<string, unknown>;
  const index = calls++;
  assert.ok(index < outputs.length, "No unplanned provider request");
  assert.equal(params.model, model.model_name);
  assert.equal(params.max_output_tokens, limits[index]);
  assert.deepEqual(params.reasoning, { effort: "none" });
  if (index === 7) throw new Error("Connection interrupted");
  const response = { id: `offline-${index}`, status: index === 5 ? "incomplete" : "completed", output: [], output_text: outputs[index],
    ...(index === 0 ? {} : { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3, output_tokens_details: { reasoning_tokens: 1 } } }),
  };
  return new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } });
};
try {
  assert.equal(await dependencies.generateSessionTitle(model, "First question"), "First title");
  assert.equal(dependencies.getAuxiliaryUsage?.().complete, false);
  assert.equal(await dependencies.generateSessionTitle(model, "Second question"), "Second title");
  assert.equal(await dependencies.generateSkillDraft?.(model, "A test skill"), skill);
  assert.equal(await dependencies.reviseSkillDraft?.(model, skill), skill);
  await dependencies.rememberMemory?.(model, dependencies.workspacePath, "Use pnpm");
  assert.ok((await dependencies.getMemoryStatus?.(dependencies.workspacePath))?.userEntries);
  await assert.rejects(dependencies.generateSessionTitle(model, "Nonterminal reply"), /incomplete/u);
  assert.equal(await dependencies.generateSessionTitle(model, "After the incomplete reply"), "After incomplete");
  await assert.rejects(dependencies.generateSkillDraft!(model, "Request fails"));
  assert.equal(await dependencies.generateSessionTitle(model, "After a failed request"), "After failed request");
  const usage = dependencies.getAuxiliaryUsage!();
  assert.equal(calls, 9);
  assert.equal(usage.complete, false);
  assert.equal(usage.input_tokens, 14);
  assert.equal(usage.output_tokens, 7);
  assert.equal(usage.reasoning_tokens, 7);
  process.stdout.write("TUI auxiliary request scopes and sticky usage passed\n");
} finally { globalThis.fetch = originalFetch; await dependencies.dispose?.(); }
