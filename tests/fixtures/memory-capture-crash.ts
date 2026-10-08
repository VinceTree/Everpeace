import { LearnedMemoryRuntime, LearnedMemoryStore } from "../../src/memory/learned-memory.js";

const directory = process.argv[2];
if (!directory || !process.send) throw new Error("An isolated store and parent IPC are required");
const interruptConsolidation = process.argv[3] === "consolidation";
let requests = 0;
const runtime = new LearnedMemoryRuntime({ store: new LearnedMemoryStore({ directory }), model: "offline",
  idleDelayMs: 0, unrefTimers: false,
  client: { responses: { async create() {
    requests++;
    if (interruptConsolidation && requests === 1) return {
      id: "settled-extraction", output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      output_text: JSON.stringify({ entries: [
        { lesson: "First verified procedure", applyWhen: "First context" },
        { lesson: "Second verified procedure", applyWhen: "Second context" },
      ] }),
    };
    process.send!({ type: "request_started" });
    return await new Promise<never>(() => {});
  } } },
});
await runtime.finishTurn({ workspacePath: directory, userInput: "Repair the interrupted task", transcript: "Verified local evidence", assistantText: "done", toolCallCount: 1 }, "verified");
