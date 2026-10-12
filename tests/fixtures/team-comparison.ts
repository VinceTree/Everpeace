/** Deterministic comparison: synthetic Responses, real Git/editor/native verification. No paid calls. */
import { promises as fs } from "node:fs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runExec } from "../../src/exec/runtime.js";
import { createProductionAgent } from "../../src/runtime/production.js";
import { SessionStore } from "../../src/storage/session-store.js";
import { TeamStore } from "../../src/team/store.js";
import { git, loadTeamWorkspace, removeTeamWorkspace } from "../../src/team/workspace.js";
import type { TeamMember } from "../../src/team/types.js";

export async function runOfflineComparison(team: boolean, failRoot = false, sameModel = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-team-comparison-"));
  const workspace = path.join(directory, "workspace"); await fs.mkdir(workspace);
  const originalFetch = globalThis.fetch;
  const root = { id: "fixture-root", model_name: "fixture-root-raw", base_url: "https://fixture.invalid/v1", api_key: "offline-placeholder", responses_profile: "generic" as const };
  const worker = sameModel ? root : { ...root, id: "fixture-worker", model_name: "fixture-worker-raw", responses_profile: "deepseek" as const };
  let rootCalls = 0; let calls = 0; let manualInterventions = 0;
  let retained: Array<{ workspace: string; source: string }> = [];
  const started = performance.now();
  try {
    await git(workspace, ["init"]);
    await fs.writeFile(path.join(workspace, ".gitignore"), "block-root\nnode_modules/\n");
    for (const name of ["a", "b"]) await fs.writeFile(path.join(workspace, `${name}.ts`), `export const ${name} = 1;\n`);
    await fs.writeFile(path.join(workspace, "check.cjs"), "const fs=require('node:fs');if(fs.existsSync('block-root'))process.exit(1);for(const name of ['a','b'])if(!new RegExp('export const '+name+' = [12];').test(fs.readFileSync(name+'.ts','utf8')))process.exit(1);\n");
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "offline-fixture", packageManager: "pnpm@10.30.3", scripts: { typecheck: "node check.cjs", test: "node check.cjs", build: "node check.cjs" } }));
    await git(workspace, ["add", "."]); await git(workspace, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
    if (failRoot) await fs.writeFile(path.join(workspace, "block-root"), "Root-only failing check; excluded from worker snapshots.\n");
    globalThis.fetch = async (_url, init) => {
      if (!String(_url).startsWith(root.base_url)) throw new Error("Offline fixture refused a non-fixture request");
      const request = JSON.parse(String(init?.body)) as { model: string; input: Array<Record<string, unknown>>; tools?: Array<{ name: string }> };
      calls++;
      const input = Array.isArray(request.input) ? request.input : [];
      const toolResults = input.filter((item) => item.type === "function_call_output");
      const call = (name: string, args: unknown, index = 0) => ({ type: "function_call", call_id: `fixture-${calls}-${index}`, name, arguments: JSON.stringify(args) });
      let output: unknown[]; let text = "";
      if (sameModel ? team && !request.tools?.some((tool) => tool.name === "spawn_agent") : request.model === worker.model_name) {
        const letter = JSON.stringify(input).includes("Edit a.ts") ? "a" : "b";
        if (!toolResults.some((item) => String(item.output).includes('"sha256"'))) output = [call("read_file", { path: `${letter}.ts` })];
        else if (!toolResults.some((item) => String(item.output).includes('"applied"'))) output = [call("apply_patch", { operations: [{ path: `${letter}.ts`, action: "update", content: `export const ${letter} = 2;\n` }] })];
        else { text = `Changed ${letter}.ts. Host checks determine verification.`; output = []; }
      } else if (!team) {
        rootCalls++;
        if (rootCalls === 1) output = [call("read_file", { path: "a.ts" }), call("read_file", { path: "b.ts" }, 1)];
        else if (rootCalls === 2) output = [call("apply_patch", { operations: ["a", "b"].map((letter) => ({ path: `${letter}.ts`, action: "update", content: `export const ${letter} = 2;\n` })) })];
        else { text = "Both fixture edits are ready for root verification."; output = []; }
      } else {
        rootCalls++;
        const members = new Map<string, TeamMember>();
        for (const item of toolResults) {
          try { const data = JSON.parse(String(item.output)) as { result?: TeamMember | TeamMember[] }; for (const member of Array.isArray(data.result) ? data.result : data.result?.agentId ? [data.result] : []) members.set(member.agentId, member); } catch { /* Other outputs have independent schemas. */ }
        }
        // Integration results are compact; update previously observed member states from them.
        for (const item of toolResults) {
          try { const data = JSON.parse(String(item.output)) as { result?: { agentId?: string; status?: string } }; if (data.result?.status === "integrated" && data.result.agentId && members.has(data.result.agentId)) members.get(data.result.agentId)!.state = "integrated"; } catch { /* Not an integration result. */ }
        }
        if (!members.size) output = ["a", "b"].map((letter, index) => call("spawn_agent", { role: "worker", goal: `Edit ${letter}.ts from 1 to 2`, acceptance: "Preserve the other source; report host check evidence", paths: [`${letter}.ts`], dependencies: [] }, index));
        else if ([...members.values()].some((member) => member.state === "queued" || member.state === "running")) output = [call("wait_agents", {})];
        else if ([...members.values()].some((member) => member.state === "completed")) output = [...members.values()].filter((member) => member.state === "completed").map((member, index) => call("integrate_agent", { agent_id: member.agentId }, index));
        else if ([...members.values()].some((member) => member.state !== "integrated")) throw new Error(`Offline member failed: ${JSON.stringify([...members.values()])}`);
        else { text = "Both team edits are ready for root verification."; output = []; }
      }
      if (calls > 40) throw new Error("Offline scenario exceeded its deterministic call guard");
      const response = { id: `fixture-response-${calls}`, status: "completed", output, output_text: text, usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 } };
      return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    };
    const result = await runExec({ prompt: "Change a.ts and b.ts values from 1 to 2; preserve other files.", model: root.id, workspacePath: workspace, ...(team ? { team: { models: { worker: worker.id }, maxAttempts: 40 } } : {}), onEvent: (event) => { if (event.type === "interaction_required") manualInterventions++; } }, {
      registry: { resolveAll: async () => ({ available: sameModel ? [root] : [root, worker], missing: [] }) }, sessionStore: new SessionStore({ directory: path.join(directory, "sessions") }),
      createAgent: (options) => createProductionAgent({ ...options, skills: null, mcp: null, learnedMemoryStore: null, codeNavigation: null, teamStore: new TeamStore(path.join(directory, "teams")) }),
    });
    retained = (result.team?.members ?? []).filter((member) => member.workspacePath).map((member) => ({ workspace: member.workspacePath!, source: workspace }));
    const correct = (await Promise.all(["a", "b"].map(async (letter) => await fs.readFile(path.join(workspace, `${letter}.ts`), "utf8") === `export const ${letter} = 2;\n`))).every(Boolean);
    const report = { scenario: failRoot ? "root-check-failure" : "two-source-edits", mode: team ? "team" : "single", evidence: "synthetic Responses with real native verification; not provider efficiency evidence", score: Number(correct && result.workflowResult === "verified"), correctFiles: correct, durationMs: Math.round(performance.now() - started), providerAttempts: result.usage?.attempts.filter((attempt) => attempt.status !== "rejected").length ?? 0, inputTokens: result.usage?.inputTokens ?? 0, outputTokens: result.usage?.outputTokens ?? 0, duplicateReads: result.team?.diagnostics?.duplicateReads ?? 0, repeatedFailures: result.team?.diagnostics?.repeatedFailures ?? 0, conflicts: result.team?.members.filter((member) => member.state === "conflict").length ?? 0, manualInterventions, classification: result.classification, memberEvidence: await Promise.all((result.team?.members ?? []).filter((member) => member.sessionId).map(async (member) => ({ agentId: member.agentId, outputs: (await new SessionStore({ directory: path.join(directory, "sessions") }).load(member.sessionId!)).timeline.filter((entry) => entry.kind === "output").slice(-1).map((entry) => ("text" in entry ? entry.text : "").slice(-3000)) }))), members: result.team?.members.map(({ state, verification, error }) => ({ state, verification, error })) ?? [], error: result.error };
    return report;
  } finally {
    globalThis.fetch = originalFetch;
    for (const artifact of retained) await removeTeamWorkspace(await loadTeamWorkspace(artifact.workspace, artifact.source));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const team of [false, true]) {
    const report = await runOfflineComparison(team, false, process.argv.includes("--same-model"));
    process.stdout.write(`${JSON.stringify(report)}\n`); assert.equal(report.score, 1, "Offline comparison failed; inspect its report");
  }
}
