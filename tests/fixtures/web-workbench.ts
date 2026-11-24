import { execFile } from "node:child_process";
import { appendFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { AgentResponse } from "../../src/agent/react-agent.js";
import { McpRuntime } from "../../src/mcp/runtime.js";
import { McpTrustStore } from "../../src/mcp/trust.js";
import { codexSandboxProfile, type PermissionMode } from "../../src/permissions/policy.js";
import { defaultModelRequestSettings, resolveProviderCapabilities } from "../../src/providers/capabilities.js";
import type { ProviderRuntime } from "../../src/providers/openai-compatible.js";
import { createProductionAgent, createProductionCommandExecutor } from "../../src/runtime/production.js";
import { SkillCatalog } from "../../src/skills/catalog.js";
import { SessionStore } from "../../src/storage/session-store.js";
import { loadBrowserAssets, loadHarnessAssets, loadHarnessDesktop, type HarnessAsset } from "../../src/web/assets.js";
import { HarnessPreferences } from "../../src/web/harness-preferences.js";
import type { DirectoryPicker } from "../../src/web/harness-directory-picker.js";
import type { HarnessDesktop } from "../../src/web/harness-desktop.js";
import { startWorkbenchServer } from "../../src/web/server.js";
import { WebWorkbench } from "../../src/web/workbench.js";
import { MemoryAuthStorage } from "./mcp-trust.js";

const model = {
  id: "offline-flash", model_name: "offline-flash", base_url: "https://compatible.invalid/v1", api_key: "fixture-key",
};
const second = { ...model, id: "offline-pro", model_name: "offline-pro" };
const goModel = { ...model, id: "offline-go-flash", model_name: "deepseek-v4.1-flash", base_url: "https://opencode.ai/inference/go/openai/v1" };
export const planFixtureCommand = "echo approved-offline-plan >> README.md";
const backgroundFixtureCommand = "echo workbench-background-ready";
const nativeBackgroundCommand = process.platform === "win32"
  ? "Write-Output 'workbench-background-ready'; Start-Sleep -Seconds 90; Write-Output 'workbench-background-unexpected'"
  : "printf 'workbench-background-ready\\n'; sleep 90; printf 'workbench-background-unexpected\\n'";

export async function startWebFixture(
  harness?: string | ReadonlyMap<string, HarnessAsset>, verifyPlan = false, slowStreamMs = 2_500,
  untrustedMcp = false, seedSkills = false, nativeBackground = false, directoryPicker?: DirectoryPicker,
  initialModel?: string,
  desktop?: HarnessDesktop,
) {
  // The CLI resolves the workspace before creating a workbench. TEMP can be a junction on Windows.
  const root = await realpath(await mkdtemp(join(tmpdir(), "everpeace-workbench-")));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "README.md"), "# Offline workbench\nSecond line.\n");
  const projectSkills = join(workspace, ".agents", "skills");
  const userSkills = join(root, "user-skills");
  const makeSkills = (root = workspace) => new SkillCatalog(root, {
    roots: [{ path: join(root, ".agents", "skills"), scope: "repo" }, { path: userSkills, scope: "user" }],
  });
  const writeSkill = async (scope: "repo" | "user", name: string, body: string) => {
    const directory = join(scope === "repo" ? projectSkills : userSkills, name);
    await mkdir(directory, { recursive: true });
    const file = join(directory, "SKILL.md");
    await writeFile(file, `---\nname: ${name}\ndescription: Fixture skill ${name}\n---\n${body}\n`);
    return file;
  };
  if (seedSkills) {
    await writeSkill("repo", "workspace-demo", "# Workspace Skill\nWorkspace invocation marker.");
    await writeSkill("user", "user-demo", "# User Skill\nUser invocation marker.");
  }
  const store = new SessionStore({ directory: join(root, "sessions") });
  const terminal = await store.create({ title: "From the terminal", titlePending: false, workspacePath: workspace, model });
  await store.appendTimeline(terminal.id, { kind: "assistant", text: "Saved before opening the workbench." });
  const foreign = await store.create({ title: "Other workspace", titlePending: false, workspacePath: root, model });
  let permissions: PermissionMode = "ask";
  let requests = 0;
  let mcpStarts = 0;
  let backgroundReleased = false;
  let lastModelInput: unknown;
  let lastModelInstructions: unknown;
  let cleanupGate: { entered(): void; outcome: Promise<Error | undefined> } | undefined;
  const modelToolLists: string[][] = [];
  const commands: string[] = [];
  const commandProfiles: string[] = [];
  const taskWorkspaces: string[] = [];
  const mcpAuth = new MemoryAuthStorage();
  const createWorkbench = () => new WebWorkbench(workspace, "en", {
    registry: { async resolveAll() { return { available: [model, second, goModel], missing: [] }; } },
    sessionStore: store,
    async loadPermissionPolicy() { return { mode: permissions, web: false }; },
    createCommandExecutor: config => {
      const { policy } = config;
      const execute = nativeBackground ? createProductionCommandExecutor(config) : undefined;
      return async (command, signal, timeout, onOutput, onChunk) => {
        commands.push(command);
        commandProfiles.push(codexSandboxProfile(typeof policy === "function" ? policy() : policy));
        if (execute && command === nativeBackgroundCommand) return execute(command, signal, timeout, onOutput, onChunk);
        if (command === backgroundFixtureCommand) {
          onChunk?.("stdout", "workbench-background-ready 后台\nsk-abcde");
          onChunk?.("stdout", "fghijklmnopqrstuvwx\n-----BEGIN PRIVATE KEY-----\nopaque-private-key-fixture\n-----END PRIVATE KEY-----\n");
          onChunk?.("stderr", "fixture-stderr\n");
          await delay(20_000, undefined, signal ? { signal } : undefined).catch(() => {});
          await delay(150);
          onChunk?.("stdout", "worker released");
          backgroundReleased = true;
          return { stdout: "workbench-background-ready\nworker released", stderr: "fixture-stderr", exitCode: null, signal: null, cancelled: signal?.aborted === true };
        }
        if (verifyPlan && command === planFixtureCommand) await appendFile(join(workspace, "README.md"), "approved-offline-plan\n");
        if (verifyPlan && / run (typecheck|lint|test|build)$/u.test(command)) {
          const implemented = (await readFile(join(workspace, "README.md"), "utf8")).includes("approved-offline-plan");
          return { stdout: "", stderr: "", exitCode: implemented ? 0 : 1, signal: null };
        }
        return { stdout: "offline tool output", stderr: "", exitCode: 0, signal: null };
      };
    },
    createAgent(options) {
      taskWorkspaces.push(options.workspacePath);
      const capabilities = resolveProviderCapabilities(options.model.base_url, options.model.model_name);
      let call = 0;
      const providerRuntime: ProviderRuntime = {
        sdk: {} as ProviderRuntime["sdk"], capabilities, settings: defaultModelRequestSettings(capabilities),
        responses: {
          async create() { throw new Error("Expected streaming"); },
          async stream(params, options) {
            requests += 1;
            lastModelInput = params.input;
            lastModelInstructions = params.instructions;
            call += 1;
            if (!Array.isArray(params.input)) throw new Error("Expected model context");
            const messages = params.input as Record<string, unknown>[];
            const prompt = JSON.stringify(messages.findLast(item => item.role === "user" && item.type === undefined) ?? {});
            const slow = prompt.includes("Slow offline task");
            const toolNames = (Array.isArray(params.tools) ? params.tools : []).flatMap(tool =>
              tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string" ? [tool.name] : []);
            modelToolLists.push(toolNames);
            const isPlan = toolNames.includes("submit_plan");
            const revised = call > 1 || prompt.includes("Include acceptance criteria");
            const executingPlan = prompt.includes("explicitly started in the browser");
            const editForGoal = prompt.includes("Write a fixture for the offline goal");
            const isTool = call === 1 && (prompt.includes("Run the offline tool") || editForGoal) ||
              executingPlan && !commands.includes(planFixtureCommand);
            const isQuestion = call === 1 && prompt.includes("Ask a question");
            const isBackground = call === 1 && prompt.includes("Run an offline background job");
            const finishGoal = toolNames.includes("update_goal") && (call === 1 && prompt.includes("Finish offline goal") || call === 2 && editForGoal);
            const text = "**Offline reply**\n\n```text\nverified browser path\n```\n\n<script>globalThis.workbenchInjected = true</script>";
            const id = `response-${requests}`;
            const output = isPlan
              ? { type: "function_call", call_id: id, name: "submit_plan", arguments: JSON.stringify({
                title: revised ? "Revised offline plan" : "Offline draft",
                plan: revised ? "Verify the revised acceptance criteria before implementing." : "Inspect README and prepare an offline example.",
              }) }
              : isBackground ? { type: "function_call", call_id: id, name: "start_background", arguments: JSON.stringify({ command: nativeBackground ? nativeBackgroundCommand : backgroundFixtureCommand }) }
              : isTool
              ? { type: "function_call", call_id: id, name: "bash", arguments: JSON.stringify({ command: executingPlan || editForGoal ? planFixtureCommand : "echo offline" }) }
              : isQuestion ? { type: "function_call", call_id: id, name: "request_user_input", arguments: JSON.stringify({
                questions: [{ id: "scope", header: "Scope", question: "Which scope?", options: [
                  { label: "Small", description: "One module" }, { label: "Large", description: "Several modules" },
                ] }],
              }) } : finishGoal
              ? { type: "function_call", call_id: id, name: "update_goal", arguments: '{"status":"complete"}' }
              : { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
            const response: AgentResponse = {
              id, status: "completed", output: [output],
              output_text: output.type === "message" ? text : "",
              usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
            };
            const signal = options?.signal instanceof AbortSignal ? options.signal : undefined;
            return (async function* () {
              if (slow || output.type === "message") {
                yield { type: "response.output_text.delta", delta: "**Offline reply**" };
                if (slow) await delay(slowStreamMs, undefined, signal ? { signal } : undefined);
                else await delay(250);
              }
              signal?.throwIfAborted();
              yield { type: "response.completed", response };
            })();
          },
        },
      };
      const mcp = untrustedMcp ? new McpRuntime({
        workspacePath: workspace,
        trustStore: new McpTrustStore({ path: join(root, "mcp-trust.json"), authStorage: mcpAuth }),
        async loadConfig() {
          return [{ name: "fixture", enabled: true, transport: { type: "stdio", command: process.execPath, args: ["-e", "process.exit(0)"] } }];
        },
        clientFactory() {
          mcpStarts += 1;
          throw new Error("An untrusted MCP server must never connect");
        },
      }) : null;
      const handle = createProductionAgent({ ...options, providerRuntime, mcp, skills: makeSkills(options.workspacePath), learnedMemoryStore: null, codeNavigation: null });
      return {
        ...handle,
        async dispose() {
          try { await handle.dispose(); }
          finally { await mcp?.close(); }
          const gate = cleanupGate;
          cleanupGate = undefined;
          if (!gate) return;
          gate.entered();
          const error = await gate.outcome;
          if (error) throw error;
        },
      };
    },
  }, makeSkills());
  try {
    if (verifyPlan) {
      await writeFile(join(workspace, "package.json"), JSON.stringify({
        scripts: { typecheck: "check-types", lint: "check-lint", test: "check-tests", build: "check-build" },
      }));
      const git = promisify(execFile);
      await git("git", ["init", "--quiet"], { cwd: workspace });
      await git("git", ["add", "--", "README.md", "package.json"], { cwd: workspace });
    }
    const [assets, harnessAssets] = await Promise.all([
      loadBrowserAssets(), typeof harness === "string" ? loadHarnessAssets(harness) : harness,
    ]);
    const createServer = (initialModel?: string) => startWorkbenchServer(
      createWorkbench(), assets, initialModel, harnessAssets, new HarnessPreferences(workspace, join(root, "browser")), directoryPicker, desktop,
    );
    const server = await createServer(initialModel);
    return {
      ...server, store, workspace, terminal, foreign, commands, commandProfiles, taskWorkspaces, requests: () => requests, mcpStarts: () => mcpStarts, lastModelInput: () => lastModelInput, lastModelInstructions: () => lastModelInstructions, modelToolLists, writeSkill,
      backgroundReleased: () => backgroundReleased,
      createServer, stop: server.close,
      tighten() { permissions = "read-only"; },
      setHostPermission(mode: PermissionMode) { permissions = mode; },
      holdCleanup() {
        let ready!: () => void;
        let finish!: (error?: Error) => void;
        const entered = new Promise<void>(resolve => { ready = resolve; });
        const outcome = new Promise<Error | undefined>(resolve => { finish = resolve; });
        cleanupGate = { entered: ready, outcome };
        return { entered, finish };
      },
      async close() {
        try { await server.close(); }
        finally { await rm(root, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startWebFixture(process.argv[2], process.argv.includes("--verify-plan"), 30_000,
    process.argv.includes("--untrusted-mcp"), process.argv.includes("--skills"), process.argv.includes("--native-background"),
    undefined, process.argv.includes("--image-model") ? goModel.id : undefined,
    process.argv.includes("--desktop") ? await loadHarnessDesktop(process.argv[2]) : undefined);
  if (process.argv.includes("--desktop")) process.stderr.write(fixture.workspace + "\n");
  if (process.argv.includes("--workspace-write")) fixture.setHostPermission("workspace-write");
  process.stdout.write(fixture.url + "\n");
  const shutdown = () => { void fixture.close(); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
