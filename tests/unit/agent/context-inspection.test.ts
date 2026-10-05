import assert from "node:assert/strict";
import { test } from "node:test";
import { ReactAgent } from "../../../src/agent/react-agent.js";
import type { FileAttachment } from "../../../src/agent/file-attachments.js";
import { resolveProviderCapabilities } from "../../../src/providers/capabilities.js";

const attachment: FileAttachment = {
  path: "src/example.ts",
  startLine: 10,
  endLine: 12,
  totalLines: 100,
  content: "const api_key = 'sk-secret-value';\nexport const safe = true;",
  sha256: "a".repeat(64),
  truncated: true,
};

test("context inspection captures the admitted coding payload and returns immutable copies", async () => {
  let request: Record<string, unknown> | undefined;
  const agent = new ReactAgent({
    model: "deepseek-chat",
    providerCapabilities: resolveProviderCapabilities("https://api.deepseek.com", "deepseek-chat"),
    client: { responses: { async create(params) {
      request = structuredClone(params);
      return { id: "done", output_text: "done", output: [], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
    } } },
    io: { async confirmBash() { return false; }, async runBash() { return { stdout: "", stderr: "", exitCode: 0, signal: null }; }, writeAssistant() {} },
  });
  assert.equal(agent.getContextSnapshot(), undefined);
  await agent.runTurn('Inspect @"src/example.ts"#L10-L12', undefined, { attachments: [attachment] });
  const snapshot = agent.getContextSnapshot();
  assert.ok(snapshot);
  assert.equal(snapshot.model, "deepseek-chat");
  assert.equal(snapshot.runtimeIdentity.agent, "Everpeace");
  assert.equal(snapshot.runtimeIdentity.protocol, "Responses");
  assert.equal(snapshot.runtimeIdentity.workspacePath, process.cwd());
  assert.equal(snapshot.attachments[0]?.path, "src/example.ts");
  assert.ok(snapshot.advertisedTools.includes("read_file"));
  assert.ok(snapshot.previews.some((preview) => preview.kind === "conversation" && preview.text.includes("Inspect")));
  assert.doesNotMatch(JSON.stringify(snapshot.previews), /sk-secret-value/u);
  assert.match(JSON.stringify(request?.input), /host_file_attachment/u);

  snapshot.attachments[0]!.path = "mutated";
  assert.equal(agent.getContextSnapshot()?.attachments[0]?.path, "src/example.ts");
});

test("context inspection remains empty when durable context admission fails", async () => {
  let providerCalls = 0;
  const agent = new ReactAgent({
    model: "deepseek-chat",
    client: { responses: { async create() { providerCalls += 1; return { id: "unexpected", output_text: "", output: [] }; } } },
    io: { async confirmBash() { return false; }, async runBash() { return { stdout: "", stderr: "", exitCode: 0, signal: null }; }, writeAssistant() {} },
    async onHistoryAppend() { throw new Error("disk full"); },
  });
  await assert.rejects(agent.runTurn("do not submit", undefined, { attachments: [attachment] }), /persistence failed/iu);
  assert.equal(providerCalls, 0);
  assert.equal(agent.getContextSnapshot(), undefined);
});
