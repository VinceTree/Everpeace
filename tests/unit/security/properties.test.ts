import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { ChildProcess } from "node:child_process";
import { propertyCheck } from "../../fixtures/property-check.js";
import { isPublicIpAddress } from "../../../src/network/public-address.js";
import { PublicConnections, withPublicResponse } from "../../../src/network/public-http.js";
import { runFileTool } from "../../../src/tools/files.js";
import { runApplyPatch, previewApplyPatch } from "../../../src/tools/apply-patch.js";
import { permissionPolicyRevision, type PermissionPolicy } from "../../../src/permissions/policy.js";
import { ReactAgent } from "../../../src/agent/react-agent.js";
import { runAgentLoop } from "../../../src/agent/agent-loop.js";
import { McpTrustStore } from "../../../src/mcp/trust.js";
import { MemoryAuthStorage } from "../../fixtures/mcp-trust.js";
import { observeProcessCompletion } from "../../../src/tools/process-completion.js";

const usage = { input_tokens: 2, output_tokens: 3, total_tokens: 5 };
const step = () => new Promise<void>((resolve) => setImmediate(resolve));
const operations = fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 12 });
async function temporary(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ep-property-")));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("public address properties use an independent reserved/global boundary table", async () => {
  await propertyCheck("dns-addresses", fc.property(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 1, max: 254 }), (a, b) => {
    assert.equal(isPublicIpAddress(`8.8.${a}.${b}`), true);
    for (const address of [`10.1.${a}.${b}`, `127.${a}.0.${b}`, `192.168.${a}.${b}`, `::ffff:8.8.${a}.${b}`, `2001:db8::${a.toString(16)}`]) assert.equal(isPublicIpAddress(address), false);
  }));
});

test("DNS rebinding sequences never connect to the second private resolution", async (t) => {
  const server = http.createServer((_request, response) => response.end("public fixture"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const original = net.connect; const connections: string[] = []; let active = 0;
  const closures: Promise<void>[] = [];
  server.on("connection", (socket) => { active++; closures.push(new Promise<void>((resolve) => socket.once("close", () => { active--; resolve(); }))); });
  t.mock.method(net, "connect", (options: net.NetConnectOpts & { host?: string }) => { connections.push(options.host!); assert.match(options.host!, /^8\.8\.8\.\d+$/u); return original({ ...options, host: "127.0.0.1", family: 4 }); });
  try {
    await propertyCheck("dns-binding", fc.asyncProperty(operations, async (sequence) => {
      for (const op of sequence) {
        let resolutions = 0; const approved = `8.8.8.${op + 1}`; const offset = connections.length;
        await withPublicResponse(new URL(`http://public.example:${address.port}`), { signal: AbortSignal.timeout(5000) }, { env: {}, lookup: async () => [{ address: ++resolutions === 1 ? approved : "127.0.0.1", family: 4 }] }, (response) => response.text());
        assert.equal(resolutions, 1); assert.deepEqual(connections.slice(offset), [approved]);
      }
      await Promise.all(closures); closures.length = 0; assert.equal(active, 0);
    }), true);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("path normalization never permits an outside read", async () => temporary(async (root) => {
  const workspace = path.join(root, "authorized"); await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, "inside.txt"), "inside"); await fs.writeFile(path.join(root, "outside.txt"), "outside-secret");
  await propertyCheck("path-normalization", fc.asyncProperty(fc.constantFrom("inside.txt", "./inside.txt", "../outside.txt", "./../outside.txt", "../authorized/../../outside.txt", "..\\outside.txt"), async (name) => {
    let result: unknown; let failure: unknown;
    try { result = await runFileTool("read_file", JSON.stringify({ path: name }), workspace); } catch (error) { failure = error; }
    if (["inside.txt", "./inside.txt"].includes(name)) { assert.equal(failure, undefined); assert.match(JSON.stringify(result), /inside/u); }
    assert.ok(!JSON.stringify(result ?? "").includes("outside-secret"));
  }));
}));

test("directory replacement between preview and write cannot modify a link target", async () => temporary(async (root) => {
  const workspace = path.join(root, "authorized"); const outside = path.join(root, "outside"); const directory = path.join(workspace, "dir");
  await fs.mkdir(workspace); await fs.mkdir(outside); await fs.writeFile(path.join(outside, "a.txt"), "canary\n");
  await propertyCheck("directory-replacement", fc.asyncProperty(fc.boolean(), async (replace) => {
    await fs.mkdir(directory); await fs.writeFile(path.join(directory, "a.txt"), "original\n");
    const patch = [{ path: "dir/a.txt", action: "update" as const, content: "changed\n" }];
    const preview = await previewApplyPatch(patch, workspace); assert.equal(preview.status, "ready");
    if (replace) { await fs.rename(directory, path.join(workspace, "saved")); await fs.symlink(outside, directory, process.platform === "win32" ? "junction" : "dir"); }
    try {
      const result = await runApplyPatch(patch.map((operation) => ({ ...operation, expectedSha256: preview.files[0]!.beforeSha256! })), workspace);
      assert.equal(result.status, replace ? "rejected" : "applied"); assert.equal(await fs.readFile(path.join(outside, "a.txt"), "utf8"), "canary\n");
    } finally {
      if (replace) { await fs.unlink(directory); await fs.rename(path.join(workspace, "saved"), directory); }
      await fs.rm(directory, { recursive: true });
    }
  }), true);
}));

test("permission revision preserves rule order equivalence and distinguishes tighter policy", async () => {
  await propertyCheck("permission-revision", fc.property(fc.array(fc.record({ prefix: fc.constantFrom("node", "git", "pnpm", "python"), action: fc.constantFrom("allow" as const, "ask" as const, "deny" as const) }), { maxLength: 12 }), (rules) => {
    const policy: PermissionPolicy = { mode: "ask", web: true, commandRules: rules };
    assert.equal(permissionPolicyRevision(policy), permissionPolicyRevision({ ...policy, commandRules: [...rules].reverse() }));
    assert.notEqual(permissionPolicyRevision(policy), permissionPolicyRevision({ ...policy, mode: "read-only" }));
  }));
  await propertyCheck("approval-revocation", fc.asyncProperty(fc.boolean(), async (approved) => {
    let policy: PermissionPolicy = { mode: "ask", web: false }; let executions = 0; let requests = 0;
    const agent = new ReactAgent({ model: "fixture", client: { responses: { async create() { return requests++ ? { id: "done", output: [], output_text: "", usage } : { id: "tool", output: [{ type: "function_call", name: "bash", call_id: "call", arguments: '{"command":"echo fixture"}' }], output_text: "", usage }; } } }, io: { getPermissions: () => policy, async confirmBash() { policy = { mode: "read-only", web: false }; return approved; }, async runBash() { executions++; return { stdout: "", stderr: "", exitCode: 0, signal: null }; }, writeAssistant() {} } });
    try { await agent.runTurn("inspect"); assert.equal(executions, 0); } finally { await agent.dispose(); }
  }), true);
});

test("cancelled or failed persistence cannot dispatch a late model tool", async () => {
  await propertyCheck("cancellation", fc.asyncProperty(fc.scheduler(), fc.boolean(), async (scheduler, failPersistence) => {
    const controller = new AbortController(); let executions = 0; let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = runAgentLoop({ async sample() { await gate; return { id: "late", output_text: "", output: [{ type: "function_call", call_id: "late", name: "bash", arguments: "{}" }] }; }, async record() { if (failPersistence) throw new Error("synthetic persistence failure"); }, async dispatch() { executions++; return ""; }, assistant() {}, signal: controller.signal });
    const stopped = running.catch(() => undefined);
    const cancellation = scheduler.schedule(Promise.resolve().then(() => { if (!failPersistence) controller.abort(); }), "host cancellation or persistence fault");
    await scheduler.waitAll(); await cancellation;
    release(); await stopped;
    assert.equal(executions, 0);
  }), true);
});

test("MCP trust state follows grants, configuration changes and revocations", async () => temporary(async (root) => {
  const store = new McpTrustStore({ path: path.join(root, "trust.json"), authStorage: new MemoryAuthStorage() });
  await propertyCheck("mcp-start-authorization", fc.asyncProperty(operations, async (sequence) => {
    let revision = 0; let approvedRevision: number | undefined;
    await store.revoke(root, "fixture");
    for (const op of sequence) {
      const preview = await store.evaluate(root, "fixture", "mcp_start", { command: "synthetic-program", revision });
      assert.equal(preview.approved, approvedRevision === revision);
      if (op === 0) { await store.grant(preview); approvedRevision = revision; }
      else if (op === 1) { await store.revoke(root, "fixture"); approvedRevision = undefined; await assert.rejects(store.grant(preview)); }
      else if (op === 2) revision++;
      else if (op === 3) { const controller = new AbortController(); controller.abort(); await assert.rejects(store.grant(preview, controller.signal)); }
    }
    await store.revoke(root, "fixture"); assert.equal((await store.evaluate(root, "fixture", "mcp_start", { revision })).approved, false);
  }), true);
}));

test("process and connection owners finish only after closure, including injected kill failure", async () => {
  await propertyCheck("resource-cleanup", fc.asyncProperty(operations, fc.boolean(), async (sequence, killFailure) => {
    const controller = new AbortController(); const child = new ChildProcess(); let killed = 0;
    child.kill = () => { killed++; if (killFailure) throw new Error("synthetic kill failure"); return true; };
    const owner = observeProcessCompletion(child, { signal: controller.signal }); let settled = false;
    const completion = owner.completion.then((result) => { settled = true; return result; });
    const connections = new PublicConnections(controller.signal); const sockets = sequence.map(() => connections.own(new net.Socket()));
    try {
      for (const op of sequence) { if (op % 2) owner.stop(); else controller.abort(); await step(); assert.equal(settled, false); }
      child.emit("close", null, "SIGKILL"); const result = await completion; await connections.close();
      assert.equal(owner.closed, true); assert.ok(killed >= 1); assert.equal(Boolean(result.cleanupError), killFailure);
      assert.ok(sockets.every((socket) => socket.destroyed && socket.listenerCount("close") === 0));
    } finally { controller.abort(); child.emit("close", null, "SIGKILL"); await completion; await connections.close(); }
  }), true);
});
