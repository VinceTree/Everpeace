import { promises as fs } from "node:fs";
import path from "node:path";
import { LearnedMemoryRuntime, LearnedMemoryStore } from "../../src/memory/learned-memory.js";

const [mode, directory, workspace, id, revision] = process.argv.slice(2) as [string, string, string, string?, string?];
const usage = { input_tokens: 2, output_tokens: 1, total_tokens: 3 };
const tell = (value: unknown) => process.send?.(value);
const response = () => ({ id: "offline", status: "completed", output: [], usage, output_text: '{"entries":[{"lesson":"Late old result","applyWhen":"fixture"}]}' });
if (mode === "clear") {
  await new LearnedMemoryStore({ directory }).clear(id === "user" ? "user" : "project", workspace);
  tell({ type: "done" }); process.disconnect?.();
} else if (mode === "crash-clear" || mode === "crash-review") {
  const stop = () => { tell({ type: "checkpoint" }); return new Promise<never>(() => {}); };
  process.on("message", () => {});
  if (mode === "crash-clear") {
    const remove = fs.rm;
    fs.rm = async (...args: Parameters<typeof fs.rm>) => String(args[0]) === new LearnedMemoryStore({ directory }).filePath("project", workspace) ? stop() : remove(...args);
    await new LearnedMemoryStore({ directory }).clear("project", workspace);
  } else {
    const rename = fs.rename;
    fs.rename = async (...args: Parameters<typeof fs.rename>) => String(args[1]) === path.join(directory, "memory-candidates.json") ? stop() : rename(...args);
    await new LearnedMemoryStore({ directory }).reviewCandidate(workspace, id!, revision!, "accept");
  }
} else {
  let release!: () => void;
  const released = new Promise<void>(done => { release = done; });
  process.on("message", () => release());
  class HeldStore extends LearnedMemoryStore {
    override async append(...args: Parameters<LearnedMemoryStore["append"]>) {
      if (mode === "automatic" && args[3]?.beforeCommit) { tell({ type: "checkpoint" }); await released; }
      return super.append(...args);
    }
  }
  const store = new HeldStore({ directory });
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", unrefTimers: false, policy: { captureFuture: mode !== "manual" },
    client: { responses: { async create() { if (mode === "manual") { tell({ type: "checkpoint" }); await released; } return response(); } } } });
  let success = false;
  try {
    if (mode === "manual") { await runtime.remember(workspace, "Remember this fixture preference"); success = true; }
    else {
      await runtime.finishTurn({ workspacePath: workspace, userInput: "Fix fixture", transcript: "Verified fixture results", assistantText: "done", toolCallCount: 1 }, "verified");
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const state = (await runtime.status(workspace)).capture?.state;
        if (state === "failed" || state === "succeeded") { success = state === "succeeded"; break; }
        await new Promise(done => setTimeout(done, 10));
      }
    }
  } catch { /* Revoked writes are expected to fail without losing reliable usage. */ }
  await runtime.dispose();
  tell({ type: "done", success, usage: (await runtime.status(workspace)).capture?.usage });
  process.disconnect?.();
}
