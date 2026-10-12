import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReactAgent } from "../../../src/agent/react-agent.js";
import { LearnedMemoryStore, memoryEntryRevision } from "../../../src/memory/learned-memory.js";

test("each real provider fallback rechecks cross-store Memory revocation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ep-memory-request-"));
  const store = new LearnedMemoryStore({ directory: root }), other = new LearnedMemoryStore({ directory: root });
  await store.append("project", root, [{ lesson: "EXPIRED_PRIVATE_LESSON", applyWhen: "fixture" }]);
  const entry = (await store.read("project", root))[0]!; const requests: string[] = [];
  const agent = new ReactAgent({ model: "fixture", workspacePath: root,
    learnedMemory: { async loadPrompt() { return (await store.snapshot(root, "fixture")).text; }, scheduleCapture() {}, async remember() {}, status: () => store.status(root), async setEnabled() {}, async clear() {} },
    client: { responses: {
      async stream(params) {
        requests.push(JSON.stringify(params));
        await other.reviewEntry("project", root, entry.id, memoryEntryRevision(entry), "disable");
        throw Object.assign(new Error("stream unsupported"), { status: 400, code: "unsupported_parameter", param: "stream" });
      },
      async create(params) { requests.push(JSON.stringify(params)); return { id: "fixture", output: [], output_text: "done", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }; },
    } },
    io: { async confirmBash() { return false; }, async runBash() { throw new Error("Unexpected shell"); }, writeAssistant() {} },
  });
  try { await agent.runTurn("fixture"); assert.equal(requests.length, 2); assert.match(requests[0]!, /EXPIRED_PRIVATE_LESSON/u); assert.doesNotMatch(requests[1]!, /EXPIRED_PRIVATE_LESSON/u); }
  finally { await agent.dispose(); await rm(root, { recursive: true, force: true }); }
});
