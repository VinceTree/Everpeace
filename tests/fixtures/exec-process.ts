import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createProcessExecCommandHost, runExecCommand } from "../../src/cli/commands/exec.js";
import { runExec } from "../../src/exec/runtime.js";
import { defaultModelRequestSettings, resolveProviderCapabilities } from "../../src/providers/capabilities.js";
import type { ProviderRuntime } from "../../src/providers/openai-compatible.js";
import { createProductionAgent } from "../../src/runtime/production.js";
import { SessionStore } from "../../src/storage/session-store.js";

// Internal subprocess fixture only: no public CLI switches, keyring access or network provider.
const [directory, scenario] = process.argv.slice(2);
if (!directory || !scenario) throw new Error("Fixture directory and scenario required");
const workspace = path.join(directory, "工作 tree");
await fs.mkdir(workspace, { recursive: true });
const model = { id: "fixture-model", model_name: "offline-model", base_url: "https://fixture.invalid/v1", api_key: "fixture-key" };
const capabilities = resolveProviderCapabilities(model.base_url, model.model_name);
let calls = 0;
const provider: ProviderRuntime = {
  sdk: {} as ProviderRuntime["sdk"], capabilities, settings: defaultModelRequestSettings(capabilities),
  responses: {
    async create() { throw new Error("Unexpected buffered request"); },
    async stream(_params, options) {
      calls += 1;
      process.send?.({ type: "provider_ready" });
      const signal = options?.signal as AbortSignal | undefined;
      if (scenario.startsWith("signal")) {
        await new Promise<never>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      const text = `${"正文😀\\\"\r\n".repeat(80_000)}Authorization: Bearer abcdefghijklmnop\nEND`;
      return (async function* () {
        yield { type: "response.completed", response: {
          id: "fixture-response", status: "completed", output_text: text,
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        } };
      })();
    },
  },
};
// Windows cannot deliver Unix signals to a detached pipe-only child; exercise its installed
// process handler over IPC there. POSIX tests send actual OS signals instead.
process.on("message", (message: unknown) => {
  if (message && typeof message === "object" && "signal" in message) {
    const signal = (message as { signal: string }).signal;
    if (signal === "SIGINT" || signal === "SIGTERM") process.emit(signal);
  }
});
const host = createProcessExecCommandHost(scenario.endsWith("stall") ? { outputStallMs: 400 } : {});
const code = await runExecCommand({ command: "exec", help: false, json: true, prompt: "fixture request", directory: workspace }, {
  async resolveAll() { return { available: [model], missing: [] }; },
}, host, {
  run: (options, dependencies) => runExec({
    ...options,
    async onEvent(event) {
      if (scenario.startsWith("stderr-") && event.type === "assistant_message") {
        await host.writeStderr("fixture diagnostic\n".repeat(100_000), options.signal);
      }
      await options.onEvent?.(event);
    },
  }, {
    ...dependencies,
    sessionStore: new SessionStore({ directory: path.join(directory, "sessions") }),
    async loadPermissionPolicy() { return { mode: "read-only", web: false }; },
    createAgent(agentOptions) {
      const handle = createProductionAgent({ ...agentOptions, providerRuntime: provider, skills: null, mcp: null, learnedMemoryStore: null, codeNavigation: null });
      const helper = spawn(process.execPath, ["-e", "/* everpeace-exec-owned-fixture */ const parent = process.ppid; const timer = setInterval(() => { try { process.kill(parent, 0); } catch { clearInterval(timer); } }, 1000)"], { stdio: "ignore" });
      const helperExit = once(helper, "exit");
      return { ...handle, async dispose() {
        await handle.dispose();
        helper.kill();
        await helperExit;
        await fs.writeFile(path.join(directory, "disposed.json"), JSON.stringify({ calls, helperPid: helper.pid }));
        if (scenario === "cleanup-failure") throw new Error("fixture cleanup failure");
      } };
    },
  }),
});
await fs.writeFile(path.join(directory, "exit.json"), JSON.stringify({ code }));
if (process.connected) process.disconnect();
process.exitCode = code;
