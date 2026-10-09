import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderRuntime } from "../../src/providers/openai-compatible.js";
import type { PermissionPolicy } from "../../src/permissions/policy.js";
import type { TuiDependencies, TuiModelRegistry } from "../../src/tui/app/types.js";
import type { ProductionAgentHandle } from "../../src/runtime/production.js";

const HELP = `Offline TUI acceptance fixture (development only)

  pnpm exec tsx tests/fixtures/tui-offline.ts --root <absolute-directory> [--integrations]

Run inside Windows Terminal. The explicit root must be empty or already owned
by this fixture. Workspace, Sessions and input history stay inside that root.
No user model registry or keyring is loaded. --integrations loads only fixture
Memory, Skills, stdio MCP and a native sandboxed protocol-fixture LSP.

Prompts: large = 300 Chinese/emoji lines; wait = cancellable 60-second request;
wait-long = cancellable 5-minute request for desktop focus delays;
cycle = edit, test passes/build fails, repair, full checks pass;
integrations = read fixture Skill, call approved MCP ping, sandboxed hover.
Anything else = immediate fake response with complete synthetic usage.
Use /resume Offline debt seed, /fork, /plan, /status, Ctrl+C and terminal resize.
Plan submits a local fixed plan; choose Cancel to preserve pending fork debt.
/plan wait-long and /plan cycle exercise those scenarios after explicit execution.
Model/verification commands use the production native sandbox, with no host
fallback. Direct ! commands are real user PTYs starting in the fixture workspace.
--help never initializes the fixture or imports the application runtime.
`;

async function createOwnedDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Fixture directories must be ordinary directories");
}

async function writeNew(filename: string, content: string): Promise<void> {
  try { await fs.writeFile(filename, content, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

function latestUser(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index] as Record<string, unknown> | undefined;
    if (item?.role !== "user") continue;
    if (typeof item.content === "string") return item.content;
    if (Array.isArray(item.content)) return item.content.map((part: unknown) => {
      if (!part || typeof part !== "object" || !("text" in part)) return "";
      return typeof part.text === "string" ? part.text : "";
    }).join("\n");
  }
  return "";
}

async function waitForCancellation(signal?: AbortSignal, timeoutMs = 60_000): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(); }, timeoutMs);
    const aborted = () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); reject(signal?.reason); };
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const integrations = args.length === 3 && args[2] === "--integrations";
  if ((args.length !== 2 && !integrations) || args[0] !== "--root" || !args[1] || !path.isAbsolute(args[1])) {
    throw new Error("Pass --root with an explicit absolute directory. Use --help for instructions.");
  }
  // Reject pipe invocations before creating directories or importing native dependencies.
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Offline TUI fixture requires a real interactive terminal; no fixture was initialized");
  const root = path.resolve(args[1]);
  await createOwnedDirectory(root);
  const markerPath = path.join(root, "offline-tui-fixture.json");
  let marker: { kind: string; version: number; seedSessionId?: string };
  try {
    marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as typeof marker;
    if (marker.kind !== "everpeace-offline-tui" || marker.version !== 1) throw new Error("Unrecognized fixture ownership marker");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if ((await fs.readdir(root)).length !== 0) throw new Error("Refusing to initialize a nonempty directory not owned by this fixture");
    marker = { kind: "everpeace-offline-tui", version: 1 };
    await fs.writeFile(markerPath, JSON.stringify(marker), { flag: "wx", mode: 0o600 });
  }
  const workspacePath = path.join(root, "workspace");
  const sessionDirectory = path.join(root, "sessions");
  await createOwnedDirectory(workspacePath);
  await createOwnedDirectory(sessionDirectory);
  await writeNew(path.join(workspacePath, "fixture.txt"), "offline fixture seed\n");
  await writeNew(path.join(workspacePath, "package.json"), JSON.stringify({ private: true, scripts: { typecheck: "node -e \"process.exit(0)\"", test: "node --test fixture.test.cjs", build: "node fixture.build.cjs" } }, null, 2));
  await writeNew(path.join(workspacePath, "fixture.test.cjs"), "const fs = require('node:fs');\nconst assert = require('node:assert/strict');\nconst { test } = require('node:test');\ntest('offline fixture content', () => assert.match(fs.readFileSync('fixture.txt', 'utf8'), /^offline fixture (seed|edited|repaired)\\n$/));\n");
  await writeNew(path.join(workspacePath, "fixture.build.cjs"), "const fs = require('node:fs'); const assert = require('node:assert/strict'); assert.notEqual(fs.readFileSync('fixture.txt', 'utf8'), 'offline fixture edited\\n', 'Expected seeded build failure');\n");
  await writeNew(path.join(workspacePath, "sample.ts"), "export const fixture = 1;\n");
  const [{ LearnedMemoryStore }, { SkillCatalog }, { McpRuntime }, { CodeNavigationRuntime }, { createLspSandboxPolicy }] = await Promise.all([
    import("../../src/memory/learned-memory.js"), import("../../src/skills/catalog.js"), import("../../src/mcp/runtime.js"), import("../../src/tools/code-navigation.js"), import("../../src/tools/sandbox-policy.js"),
  ]);
  const memoryStore = integrations ? new LearnedMemoryStore({ directory: path.join(root, "memory") }) : null;
  const skillRoot = path.join(root, "skills");
  if (integrations) {
    await createOwnedDirectory(path.join(skillRoot, "offline-guide"));
    await writeNew(path.join(skillRoot, "offline-guide", "SKILL.md"), "---\nname: offline-guide\ndescription: Isolated offline acceptance guide\n---\nRead the current fixture file before editing.\n");
    await memoryStore!.append("project", workspacePath, [{ lesson: "Offline fixture prefers verified changes.", applyWhen: "Working with fixture.txt", kind: "convention", confidence: "high" }]);
  }
  const skills = integrations ? new SkillCatalog(workspacePath, { roots: [{ path: skillRoot, scope: "repo" }] }) : null;
  const mcp = integrations ? new McpRuntime({ workspacePath, async loadConfig() { return [{ name: "offline", enabled: true, transport: { type: "stdio", command: process.execPath, args: ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("offline-mcp.ts", import.meta.url))] }, startup_timeout_sec: 15 }]; } }) : null;
  const serverPath = path.join(root, "services", "offline-lsp.mjs");
  if (integrations) {
    await createOwnedDirectory(path.dirname(serverPath));
    await writeNew(serverPath, await fs.readFile(fileURLToPath(new URL("offline-lsp.mjs", import.meta.url)), "utf8"));
  }
  const navigation = integrations ? new CodeNavigationRuntime({ workspacePath, command: process.execPath, args: [serverPath], policy: createLspSandboxPolicy(workspacePath, [path.dirname(process.execPath), path.dirname(serverPath)]) }) : null;
  const [
    { runTui }, { SessionStore }, { InputHistory }, { createWorkflowState },
    { createProductionAgent, createProductionCommandExecutor },
    { defaultModelRequestSettings, resolveProviderCapabilities }, { runTerminalCommand },
  ] = await Promise.all([
    import("../../src/tui/index.js"), import("../../src/storage/session-store.js"), import("../../src/storage/input-history.js"),
    import("../../src/workflow/types.js"), import("../../src/runtime/production.js"),
    import("../../src/providers/capabilities.js"), import("../../src/tools/terminal.js"),
  ]);
  const model = { id: "offline-tui-model", model_name: "offline-fixture", base_url: "https://offline-fixture.invalid/v1", api_key: "offline-not-a-credential" };
  const registration = { id: model.id, model_name: model.model_name, base_url: model.base_url, auth_ref: "fixture-only", created_at: "2026-10-02T00:00:00.000Z", updated_at: "2026-10-02T00:00:00.000Z" };
  const registry: TuiModelRegistry = {
    async resolveAll() { return { available: [model], missing: [] }; },
    async listStatuses() { return [{ ...registration, credential_status: "ready" }]; },
    async registerMany() { throw new Error("Model registration is disabled in this offline fixture"); },
    async removeMany() { throw new Error("The offline fixture model cannot be removed"); },
  };
  const sessionStore = new SessionStore({ directory: sessionDirectory });
  if (!marker.seedSessionId) {
    const seed = await sessionStore.create({ title: "Offline debt seed", titlePending: false, workspacePath, model: { id: model.id, model_name: model.model_name, base_url: model.base_url } });
    const text = "Offline fixture: fixture.txt has inherited verification debt. Reopen, fork, enter Plan, cancel coding, then resume coding to exercise production recovery.";
    await sessionStore.appendTimeline(seed.id, { kind: "user", text: "Preserve the fixture's unfinished verification." });
    await sessionStore.appendTimeline(seed.id, { kind: "assistant", text });
    await sessionStore.appendContext(seed.id, [{ role: "user", content: "Preserve the fixture's unfinished verification." }, { role: "assistant", content: text }]);
    await sessionStore.setWorkflow(seed.id, { ...createWorkflowState("offline-seed-task"), phase: "review", changed_paths: ["fixture.txt"], pending_verification: true, result: "unverified", result_reason: "Offline fixture starts before host verification" });
    await sessionStore.setMemoryPolicy(seed.id, { readExisting: false, captureFuture: false });
    marker.seedSessionId = seed.id;
    await fs.writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
  }
  let requests = 0;
  let cycleStep = 0;
  let integrationsCalled = false;
  const capabilities = resolveProviderCapabilities(model.base_url, model.model_name);
  const provider: ProviderRuntime = {
    sdk: {} as ProviderRuntime["sdk"], capabilities, settings: defaultModelRequestSettings(capabilities),
    responses: {
      async create() { throw new Error("The offline fixture expects the production streaming path"); },
      async stream(params, options) {
        const id = `offline-response-${++requests}`;
        const userPrompt = latestUser(params.input).trim();
        const prompt = /^Implement the following plan\b/u.test(userPrompt)
          ? /Offline fixture scenario: (wait-long|cycle)\b/u.exec(userPrompt)?.[1] ?? userPrompt
          : userPrompt;
        const signal = options?.signal as AbortSignal | undefined;
        const planMode = Array.isArray(params.tools) && params.tools.some((tool) => tool && typeof tool === "object" && "name" in tool && tool.name === "submit_plan");
        if (!planMode && /^wait\b/iu.test(prompt)) await waitForCancellation(signal, /^wait-long\b/iu.test(prompt) ? 300_000 : 60_000);
        signal?.throwIfAborted();
        const scenario = /^(wait-long|cycle)\b/u.exec(prompt)?.[1];
        const plan = scenario
          ? `Offline fixture scenario: ${scenario}\nInspect the fixture, run this scenario only after explicit execution, and preserve host verification and cancellation.`
          : "1. Inspect the inherited verification debt.\n2. Cancel this Plan review.\n3. Run wait and cancel with Ctrl+C.\n4. Resume coding and let the production host verify the fixture.";
        const text = /^large\b/iu.test(prompt)
          ? Array.from({ length: 300 }, (_, index) => `Line ${String(index + 1).padStart(3, "0")} · 中文恢复与滚动检查 😀 · indentation:    value`).join("\n")
          : "Offline fixture response. No model connection was used; the production host owns verification and completion.";
        let output: Array<Record<string, unknown> & { type: string }> = planMode
          ? [{ type: "function_call", call_id: `${id}-plan`, name: "submit_plan", arguments: JSON.stringify({ title: "Offline acceptance plan", plan }) }]
          : [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }];
        const call = (name: string, value: unknown) => ({ type: "function_call", call_id: `${id}-${name}`, name, arguments: JSON.stringify(value) });
        if (!planMode && (/^cycle\b/iu.test(prompt) || (cycleStep > 0 && cycleStep < 6))) {
          cycleStep++;
          if (cycleStep === 1 || cycleStep === 4) output = [call("read_file", { path: "fixture.txt" })];
          else if (cycleStep === 2 || cycleStep === 5) output = [call("apply_patch", { operations: [{ path: "fixture.txt", action: "update", content: cycleStep === 2 ? "offline fixture edited\n" : "offline fixture repaired\n" }] })];
        } else if (!planMode && integrations && /^integrations\b/iu.test(prompt) && !integrationsCalled) {
          integrationsCalled = true;
          const mcpName = (await mcp!.ensureReady()).tools[0]!.name;
          output = [call("read_skill", { name: "offline-guide" }), call(mcpName, {}), call("code_navigation", { operation: "hover", path: "sample.ts", line: 1, column: 14 })];
        }
        return (async function* () {
          yield { type: "response.completed", response: { id, status: "completed", output, output_text: planMode ? "" : text, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } };
        })();
      },
    },
  };
  const handles = new Set<ProductionAgentHandle>();
  let policy: PermissionPolicy = { mode: "workspace-write", web: false, shellNetwork: "deny" };
  const dependencies: TuiDependencies = {
    registry, version: "offline-fixture", workspacePath, sessionStore,
    inputHistory: new InputHistory(path.join(root, "input-history.json")),
    async listModels() { return [model.model_name]; },
    async generateSessionTitle(_model, question) { return `Offline: ${question.trim().split(/\r?\n/u)[0]?.slice(0, 48) ?? "session"}`; },
    async changeWorkspace(target) {
      if (path.resolve(target) !== workspacePath) throw new Error("This fixture keeps one fixed workspace");
      return workspacePath;
    },
    async loadPermissions() { return { ...policy }; },
    async savePermissions(_workspace, next) {
      if (next.mode === "full-access" || next.web) throw new Error("Offline fixture permissions must remain workspace-scoped with networking denied");
      policy = { ...next, shellNetwork: "deny" };
    },
    createAgent(selected, io, restore) {
      const handle = createProductionAgent({
        model: selected, io, workspacePath, sessionStore, sessionId: () => io.getSessionId?.(), providerRuntime: provider,
        skills, mcp, learnedMemoryStore: memoryStore, codeNavigation: navigation,
        learnedMemoryPolicy: { readExisting: integrations, captureFuture: false },
        restore: {
          ...(restore?.initialContext === undefined ? {} : { initialHistory: restore.initialContext }),
          ...(restore?.initialTaskProgress === undefined ? {} : { initialTaskProgress: restore.initialTaskProgress }),
          ...(restore?.contextWindow === undefined ? {} : { contextWindow: restore.contextWindow }),
          ...(restore?.initialContextTokens === undefined ? {} : { initialContextTokens: restore.initialContextTokens }),
          ...(restore?.onContextAppend === undefined ? {} : { onHistoryAppend: restore.onContextAppend }),
          ...(restore?.onContextCompacted === undefined ? {} : { onContextCompacted: restore.onContextCompacted }),
          ...(restore?.onContextPruned === undefined ? {} : { onContextPruned: restore.onContextPruned }),
          ...(restore?.onUsage === undefined ? {} : { onUsage: restore.onUsage }),
          ...(restore?.onPhase === undefined ? {} : { onPhase: restore.onPhase }),
          ...(restore?.onEvent === undefined ? {} : { onEvent: restore.onEvent }),
        },
      });
      handles.add(handle);
      return handle.agent;
    },
    runBash(command, activePolicy, signal, onOutput, timeoutMs) {
      return createProductionCommandExecutor({ workspacePath, policy: { ...activePolicy, mode: activePolicy.mode === "full-access" ? "workspace-write" : activePolicy.mode, web: false, shellNetwork: "deny" }, readableRoots: [] })(command, signal, timeoutMs, onOutput);
    },
    runTerminalCommand(command, onOutput, signal, onInputReady) {
      return runTerminalCommand(command, { cwd: workspacePath, streamOutput: false, ...(onOutput ? { onOutput } : {}), ...(signal ? { signal } : {}), ...(onInputReady ? { onInputReady } : {}) });
    },
    async getMcpStatus() { return mcp ? JSON.stringify((await mcp.ensureReady()).servers) : "MCP disabled in this offline fixture."; },
    async getSkillsStatus() { return skills ? JSON.stringify(await skills.refresh()) : "Skills disabled in this offline fixture."; },
    ...(memoryStore ? { async getMemoryStatus() { const entries = await memoryStore.read("project", workspacePath); return { enabled: true, projectEntries: entries.length, userEntries: 0, recent: entries }; } } : {}),
    async doctor() { return integrations ? "Offline fixture: isolated Memory, Skills, stdio MCP and native protocol LSP are loaded. No live model diagnostic is available." : "Offline fixture: Memory, MCP, Skills and navigation are disabled. No live model diagnostic is available."; },
    async dispose() { const results = await Promise.allSettled([...Array.from(handles, (handle) => handle.dispose()), ...(mcp ? [mcp.close()] : [])]); for (const result of results) if (result.status === "rejected") throw result.reason; },
  };
  const previousDirectory = process.cwd();
  process.chdir(workspacePath);
  try { return await runTui({ registry, dependencies }); }
  finally { process.chdir(previousDirectory); }
}

void main().then((code) => { process.exitCode = code; }, (error: unknown) => {
  process.stderr.write(`Offline TUI fixture: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
