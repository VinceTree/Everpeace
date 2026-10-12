import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { SkillCatalog } from "../../../src/skills/catalog.js";
import { SkillManager } from "../../../src/skills/manager.js";
import { ReactAgent } from "../../../src/agent/react-agent.js";
import { runFileTool } from "../../../src/tools/files.js";
import { ProcessCleanupError } from "../../../src/tools/process-completion.js";
import { runProjectMap } from "../../../src/tools/project-map.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(context: TestContext, failTree: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-read-process-"));
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 123456789 });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const killers: ChildProcess[] = [];
  let started!: () => void;
  const spawned = new Promise<void>((resolve) => { started = resolve; });
  let launches = 0;
  let preparationRoot: string | undefined;
  let closed = false, removedBeforeClose = false;
  child.once("close", () => { closed = true; });
  const remove = fs.rm.bind(fs);
  context.mock.method(fs, "rm", (target: Parameters<typeof fs.rm>[0], options: Parameters<typeof fs.rm>[1]) => {
    if (target === preparationRoot && !closed) removedBeforeClose = true;
    return remove(target, options);
  });
  context.mock.method(childProcess, "spawn", (command: string, args: string[]) => {
    if (command === "taskkill.exe") {
      const killer = new ChildProcess();
      killers.push(killer);
      return killer;
    }
    launches++;
    if (command === "git") preparationRoot = path.dirname(args.at(-1)!);
    started();
    return child;
  });
  context.mock.method(process, "kill", () => {
    if (failTree) throw new Error("fixture tree refused");
    return true;
  });
  context.mock.method(child, "kill", () => true);
  syncBuiltinESMExports();
  context.after(async () => {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    child.stdout?.destroy(); child.stderr?.destroy();
    await fs.rm(root, { recursive: true, force: true });
    if (preparationRoot) {
      assert.equal(path.dirname(preparationRoot), os.tmpdir());
      assert.ok(path.basename(preparationRoot).startsWith("everpeace-skill-install-"));
      await fs.rm(preparationRoot, { recursive: true, force: true });
    }
  });
  const manager = new SkillManager({
    workspacePath: root, catalog: new SkillCatalog(root),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  return { root, child, killers, spawned, manager, launches: () => launches, preparationRoot: () => preparationRoot, removedBeforeClose: () => removedBeforeClose };
}

for (const tool of ["search", "map", "skill"] as const) {
  const run = (value: Awaited<ReturnType<typeof fixture>>, signal?: AbortSignal) => tool === "search"
    ? runFileTool("search_files", '{"query":"needle","path":"."}', value.root, signal, undefined, async () => process.execPath)
    : tool === "map" ? runProjectMap({}, value.root, signal, async () => process.execPath)
      : value.manager.prepareInstall("https://example.com/skills.git", signal);

  test(`${tool} preserves process-tree cleanup failure over ordinary cancellation`, async (context) => {
    const value = await fixture(context, true);
    const controller = new AbortController();
    const result = run(value, controller.signal);
    const observed = assert.rejects(result, ProcessCleanupError);
    await value.spawned;
    controller.abort(new Error("ordinary cancellation"));
    await flush();
    value.child.emit("close", null, "SIGKILL");
    value.killers[0]?.emit("close", 1);
    await observed;
    assert.equal(value.launches(), 1);
    if (tool === "skill") {
      await fs.access(value.preparationRoot()!);
      await assert.rejects(value.manager.prepareInstall("https://example.com/again.git"), ProcessCleanupError);
      assert.equal(value.launches(), 1);
      await assert.rejects(value.manager.close(), ProcessCleanupError);
    }
  });

  test(`${tool} transport failure cannot settle before owned process close`, async (context) => {
    const value = await fixture(context, false);
    let finished = false;
    const result = run(value);
    void result.then(() => { finished = true; }, () => { finished = true; });
    const rejected = assert.rejects(result, /fixture transport failed/);
    await value.spawned;
    value.child.emit("error", new Error("fixture transport failed"));
    await flush();
    const finishedBeforeClose = finished;
    value.killers[0]?.emit("close", 0);
    value.child.emit("close", null, "SIGKILL");
    await rejected;
    assert.equal(finishedBeforeClose, false);
    assert.equal(value.removedBeforeClose(), false, "staging cannot be removed while an owned process is live");
  });
}

test("Skill manager disposal owns an active Git preparation and shares its wait", async (context) => {
  const value = await fixture(context, false);
  const preparation = value.manager.prepareInstall("https://example.com/skills.git");
  const rejected = assert.rejects(preparation);
  await value.spawned;
  let finished = false;
  const first = value.manager.close(), second = value.manager.close();
  void first.then(() => { finished = true; });
  await flush();
  const finishedBeforeClose = finished;
  value.killers[0]?.emit("close", 0);
  value.child.emit("close", null, "SIGKILL");
  await Promise.all([first, second, rejected]);
  assert.equal(finishedBeforeClose, false);
  assert.equal(first, second);
  await assert.rejects(value.manager.prepareInstall("https://example.com/again.git"), /closed/i);
  assert.equal(value.launches(), 1);
});

for (const name of ["search_files", "project_map"] as const) {
  test(`${name} cleanup failure closes Agent tool pairs and later admission`, async (context) => {
    const value = await fixture(context, true);
    let requests = 0;
    const persisted: Array<Record<string, unknown>> = [];
    const agent = new ReactAgent({
      workspacePath: value.root, model: "offline-read-cleanup",
      client: { responses: { async create() {
        requests++;
        return { id: "read", output_text: "", output: [
          { type: "function_call", name, call_id: "first", arguments: name === "search_files" ? '{"query":"needle"}' : '{}' },
          { type: "function_call", name: "bash", call_id: "second", arguments: '{"command":"must not start"}' },
        ] };
      } } },
      io: { async confirmBash() { return true; }, async runBash() { throw new Error("Unexpected shell"); }, writeAssistant() {} },
      async onHistoryAppend(items) { persisted.push(...items); },
    });
    const rejected = assert.rejects(agent.runTurn("Inspect the project"), ProcessCleanupError);
    await value.spawned;
    value.child.emit("error", new Error("fixture transport failed"));
    await flush();
    value.child.emit("close", null, "SIGKILL");
    value.killers[0]?.emit("close", 1);
    await rejected;
    const outputs = persisted.filter((item) => item.type === "function_call_output");
    assert.deepEqual(outputs.map((item) => item.call_id), ["first", "second"]);
    assert.equal(JSON.parse(String(outputs[0]?.output)).cleanup_failed, true);
    assert.equal(JSON.parse(String(outputs[1]?.output)).reason, "process_cleanup_failed");
    await assert.rejects(agent.runTurn("Retry"), ProcessCleanupError);
    await assert.rejects(agent.dispose(), ProcessCleanupError);
    assert.equal(requests, 1);
    assert.equal(value.launches(), 1);
  });
}
