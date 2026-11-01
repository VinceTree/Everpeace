import { isolateOfflineModelProxy } from "./offline-model-proxy.js";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AuxiliaryRequestExecutor } from "../../src/agent/auxiliary-request-executor.js";
import { LearnedMemoryRuntime, LearnedMemoryStore } from "../../src/memory/learned-memory.js";
import { createProductionAgent } from "../../src/runtime/production.js";
import { SessionStore } from "../../src/storage/session-store.js";

const root = process.env.EVERPEACE_MEMORY_ACCOUNTING_ROOT;
if (!root || process.cwd() !== root) throw new Error("An isolated SDK accounting directory is required");
const usage = { input_tokens: 2, output_tokens: 1, total_tokens: 3 };
const zero = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
const originalFetch = globalThis.fetch;
const restoreProxy = isolateOfflineModelProxy();
let requests = 0;
globalThis.fetch = async () => {
  requests++;
  return new Response(JSON.stringify({ id: "offline-memory", status: "completed", output: [],
    output_text: '{"entries":[{"lesson":"Use pnpm","applyWhen":"Node projects"}]}', usage,
  }), { headers: { "Content-Type": "application/json" } });
};
try {
  for (const mode of ["known-cancel", "pre-cancel", "success"] as const) {
    const before = requests;
    const controller = new AbortController();
    const auxiliary = new AuxiliaryRequestExecutor();
    const store = new LearnedMemoryStore({ directory: join(root, mode, "memory") });
    const handle = createProductionAgent({
      model: { id: "offline", model_name: "deepseek-v4-flash", base_url: "https://api.deepseek.com", api_key: "fixture" },
      workspacePath: root, sessionStore: new SessionStore({ directory: join(root, mode, "sessions") }),
      sessionId: () => undefined, skills: null, mcp: null, codeNavigation: null,
      learnedMemoryStore: store, learnedMemoryPolicy: { captureFuture: false },
      io: { async confirmBash() { return false; }, async runBash() { throw new Error("Unexpected shell request"); }, writeAssistant() {} },
      runMemoryRequest: (run, context) => {
        if (mode === "pre-cancel") controller.abort(new Error("Cancelled before SDK admission"));
        return auxiliary.execute("memory", async (signal) => {
          const result = await run(signal);
          if (mode === "known-cancel") controller.abort(new Error("Cancelled after SDK decoding"));
          return result;
        }, context.signal, context.signal, context);
      },
    });
    assert.ok(handle.learnedMemory instanceof LearnedMemoryRuntime);
    try {
      const remembering = handle.learnedMemory.remember(root, "Use pnpm", controller.signal);
      if (mode === "success") await remembering;
      else await assert.rejects(remembering, mode === "pre-cancel" ? /before SDK admission/u : /after SDK decoding/u);
      const expected = mode === "pre-cancel" ? zero : usage;
      assert.equal(requests - before, mode === "pre-cancel" ? 0 : 1);
      assert.deepEqual((await handle.learnedMemory.status(root)).capture?.usage, expected);
      assert.equal(auxiliary.getUsage().input_tokens, expected.input_tokens);
      assert.equal(auxiliary.getUsage().output_tokens, expected.output_tokens);
      assert.equal(auxiliary.getUsage().complete, true);
      assert.equal((await store.read("user", root)).length, mode === "success" ? 1 : 0);
    } finally { await Promise.all([handle.dispose(), auxiliary.dispose()]); }
    assert.equal(requests - before, mode === "pre-cancel" ? 0 : 1);
  }
  process.stdout.write("Production SDK Memory accounting and cancellation passed\n");
} finally { globalThis.fetch = originalFetch; restoreProxy(); }
