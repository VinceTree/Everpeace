import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { eventFrames } from "../../../src/web/browser/connection.js";
import { HarnessJobs } from "../../../src/web/harness-jobs.js";
import type { HarnessDesktop } from "../../../src/web/harness-desktop.js";
import { planFixtureCommand, startWebFixture } from "../../fixtures/web-workbench.js";

function harnessClient(address: string, signal?: AbortSignal) {
  const url = new URL(address);
  const headers = { Origin: url.origin, Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json" };
  const post = (body: object, auth = headers) => fetch(new URL("/api/harness", url.origin), {
    method: "POST", headers: auth, body: JSON.stringify(body), signal: signal ?? null,
  });
  const eventConnections = new Map<unknown, string>();
  const call = async (endpoint: string, args: unknown = {}, connectionId?: string) => {
    const owner = endpoint === "$events/result" ? eventConnections.get((args as { clientId?: string }).clientId) : undefined;
    const response = await post({ operation: "call", endpoint, payload: { args }, connectionId: connectionId ?? owner });
    assert.equal(response.status, 200);
    return response.json();
  };
  async function connect(onFrame?: (item: Record<string, unknown>) => void | Promise<void>) {
    const connectionId = randomUUID();
    const connection = await post({ operation: "connect", connectionId });
    assert.equal(connection.status, 200);
    const feed = eventFrames(connection.body!);
    async function subscribe(endpoint: string, args: unknown = {}) {
      const streamId = randomUUID();
      const response = await post({ operation: "subscribe", endpoint, connectionId, streamId, payload: { args } });
      assert.equal(response.status, 200, `could not subscribe to ${endpoint}`);
      return streamId;
    }
    async function until(matches: (item: Record<string, unknown>) => boolean, streamId: string) {
      for (;;) {
        const { done, value } = await feed.next();
        if (done) throw new Error("Harness connection closed");
        const frame = value as { streamId: string; item: Record<string, unknown>; done?: true };
        const item = frame.done ? { type: "stream-end" } : frame.item;
        if (item.type === "ready") eventConnections.set(item.clientId, connectionId);
        await onFrame?.(item);
        if (frame.streamId === streamId && matches(item)) return item;
      }
    }
    return { subscribe, until, connectionId };
  }
  return { call, post, headers, connect };
}

const harnessAssets = new Map([["/", { type: "text/html", content: Buffer.from("<main>Harness</main>") }]]);

function isTurnEnd(item: Record<string, unknown>): boolean {
  return item.type === "event" && (item.event as { type?: string }).type === "turn/end";
}

function reason(item: Record<string, unknown>) {
  return (item.event as { data: { reason: unknown } }).data.reason;
}

test("stock desktop routes discover apps, validate registered paths and hand off explicit file gestures", { timeout: 20_000 }, async t => {
  const launches: unknown[][] = [];
  const applications = [{ id: "fixture-viewer", name: "Fixture Viewer", default: true, icon: null }];
  const desktop: HarnessDesktop = {
    available: true,
    async apps() { return ["fixture-editor"]; },
    async icon(id) { return id === "fixture-editor" ? { bytes: Uint8Array.of(1, 2, 3), contentType: "image/png" } : null; },
    async openDirectory(id, verify, signal) {
      if (id !== "fixture-editor") return "unavailable";
      const path = await verify();
      signal.throwIfAborted();
      launches.push(["directory", path]);
      return "launched";
    },
    async applications(path) { launches.push(["associations", path]); return applications; },
    async openFile(path, action, application) {
      if (application && !applications.some(item => item.id === application)) throw new Error("Unknown application");
      launches.push([action, path, application]);
    },
  };
  let selected: string | null = null;
  const fixture = await startWebFixture(harnessAssets, false, 250, false, false, false, async () => selected, undefined, desktop);
  const controller = new AbortController();
  t.after(async () => { controller.abort(); await fixture.close(); });
  const { call, connect, headers } = harnessClient(fixture.url, controller.signal);
  const origin = new URL(fixture.url).origin;
  const get = (route: string, auth = true) => fetch(origin + route, { headers: auth ? headers : {}, signal: controller.signal });
  const open = (path: string, app = "fixture-editor", requestHeaders = headers) => fetch(origin + "/open-in-app/open", {
    method: "POST", headers: requestHeaders, body: JSON.stringify({ app, path }), signal: controller.signal,
  });
  assert.equal((await get("/open-in-app/apps", false)).status, 401);
  const { apps, iconPrefix } = await (await get("/open-in-app/apps")).json();
  assert.deepEqual(apps, ["fixture-editor"]);
  assert.match(iconPrefix, /^\/open-in-app\/icon\/[\w-]{32}\/$/u);
  const icon = await get(iconPrefix + "fixture-editor", false);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await icon.arrayBuffer()), Uint8Array.of(1, 2, 3));
  assert.equal((await get("/open-in-app/icon/fixture-editor", false)).status, 401);
  assert.equal((await get(iconPrefix + "missing", false)).status, 404);
  const work = await realpath(fixture.workspace);
  assert.equal((await open(work, "fixture-editor", { ...headers, Authorization: "" })).status, 401);
  assert.equal((await open(work, "fixture-editor", { ...headers, Origin: "https://foreign.invalid" })).status, 403);
  assert.equal((await open(work, "arbitrary-executable")).status, 400);
  assert.equal((await open(dirname(work))).status, 404);
  assert.deepEqual(await (await open(work)).json(), { ok: true });
  assert.deepEqual(await call("session/canOpenWorkspacePath"), { ok: true, value: true });
  const file = join(work, "report, 中文.txt");
  const commandFile = join(work, "launch.cmd");
  const sensitive = join(work, ".env");
  for (const path of [file, commandFile, sensitive]) await writeFile(path, "fixture only");
  const query = (path: string) => call("session/workspacePathApplications", { path });
  const launch = (path: string, args: object = {}) => call("session/openWorkspacePath", { path, ...args });
  assert.deepEqual((await query(file)).value, applications);
  assert.deepEqual((await launch(file, { application: "fixture-viewer" })).value, { opened: true });
  assert.deepEqual((await launch(file, { action: "reveal" })).value, { opened: true });
  assert.equal((await launch(file, { application: "arbitrary-executable" })).error.code, "gateway/internal");
  assert.equal((await launch(file, { action: "execute" })).ok, false);
  assert.equal((await launch(commandFile)).ok, false);
  assert.deepEqual((await launch(commandFile, { action: "reveal" })).value, { opened: true });
  assert.equal((await launch(sensitive, { action: "reveal" })).ok, false);
  assert.equal((await launch(join(work, "missing.txt"))).ok, false);
  const nested = join(dirname(work), "other project");
  await mkdir(nested);
  const other = join(nested, "other.txt");
  await writeFile(other, "other project");
  assert.equal((await launch(other)).ok, false);
  const link = join(work, "logical-link");
  await symlink(nested, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await launch(join(link, "other.txt"), { action: "reveal" })).ok, false);
  selected = nested;
  const connection = await connect();
  assert.ok((await call("directoryPicker/pick", {}, connection.connectionId)).ok);
  assert.ok((await call("workspace/create", { path: nested }, connection.connectionId)).ok);
  assert.ok((await open(nested)).ok);
  assert.ok((await launch(other)).ok);
  await rename(nested, nested + " moved");
  await mkdir(nested);
  await writeFile(other, "replacement");
  assert.equal((await open(nested)).status, 409);
  assert.equal((await launch(other, { action: "reveal" })).error.code, "workspace/invalid-path");
  assert.deepEqual(launches, [["directory", work], ["associations", file], ["open", file, "fixture-viewer"],
    ["reveal", file, undefined], ["reveal", commandFile, undefined], ["directory", nested], ["open", other, undefined]]);
});

test("stock team mode toggles the Session projection and passes the production team option", { timeout: 20_000 }, async t => {
  const fixture = await startWebFixture(harnessAssets);
  t.after(() => fixture.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const { call } = harnessClient(fixture.url, controller.signal);
  const { value: { sessionId } } = await call("session/create");
  const disabled = (await call("session/projections", { sessionId })).value.values.agentTeam;
  assert.deepEqual(disabled, { enabled: false, tasks: [] });
  assert.deepEqual(await call("agentTeams/setEnabled", { agentId: sessionId, enabled: true }), { ok: true });
  assert.deepEqual((await call("session/projections", { sessionId })).value.values.agentTeam, { enabled: true, tasks: [] });
  assert.deepEqual(await call("agentTeams/setEnabled", { agentId: sessionId, enabled: false }), { ok: true });
  assert.deepEqual((await call("session/projections", { sessionId })).value.values.agentTeam, { enabled: false, tasks: [] });
  assert.equal((await call("agentTeams/setEnabled", { agentId: fixture.foreign.id, enabled: true })).ok, false);
});

test("stock plugin inventory persists browser profile enablement", { timeout: 20_000 }, async t => {
  const fixture = await startWebFixture(harnessAssets);
  t.after(() => fixture.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const { call } = harnessClient(fixture.url, controller.signal);
  const inventory = await call("pluginInventory/list");
  assert.equal(inventory.value.managementAvailable, true);
  assert.ok(inventory.value.entries.some((entry: { entryId: string }) => entry.entryId === "everpeace:dsh-client-ui-agent-team"));
  const changed = await call("pluginManager/setPluginEnabled", { id: "everpeace:dsh-client-ui-agent-team", enabled: false });
  assert.equal(changed.value.application, "restart-required");
  const plugin = (await call("pluginManager/listPlugins")).value.find((entry: { entryId: string }) => entry.entryId === "everpeace:dsh-client-ui-agent-team");
  assert.equal(plugin.enabled, false);
  assert.equal((await call("pluginManager/setPluginEnabled", { id: "unknown-plugin", enabled: true })).ok, false);
});

test("stock automation tasks persist, run on demand, and deliver a delayed prompt", { timeout: 20_000 }, async t => {
  const fixture = await startWebFixture(harnessAssets);
  t.after(() => fixture.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const { call, connect } = harnessClient(fixture.url, controller.signal);
  const { value: { sessionId } } = await call("session/create");
  const delayed = await call("schedule/create", { request: {
    title: "Delayed fixture", prompt: "Delayed scheduled task", timing: { kind: "after", after_seconds: 1 }, target: { kind: "session", sessionId },
  } });
  assert.equal(delayed.ok, true);
  await new Promise(resolve => setTimeout(resolve, 1_500));
  const delayedSaved = await fixture.store.load(sessionId);
  assert.ok(delayedSaved.timeline.some(item => item.kind === "user" && item.text === "Delayed scheduled task"));
  assert.equal((await call("schedule/catalog")).value[0].status, "ended");
  const created = await call("schedule/create", { request: {
    title: "Fixture reminder", prompt: "Run the scheduled offline task", timing: { kind: "after", after_seconds: 60 },
    target: { kind: "session", sessionId },
  } });
  assert.equal(created.ok, true);
  assert.equal(created.value.status, "active");
  assert.equal((await call("schedule/list", { request: { active: true } })).value.total, 1);
  assert.equal((await call("schedule/catalog")).value.find((task: { title: string }) => task.title === "Fixture reminder")?.title, "Fixture reminder");
  const updated = await call("schedule/edit", { request: { id: created.value.id, action: "update", patch: { title: "Edited reminder" } } });
  assert.equal(updated.value.title, "Edited reminder");
  const ran = await call("schedule/run", { request: { id: created.value.id } });
  assert.equal(ran.value.status, "ended");
  await new Promise(resolve => setTimeout(resolve, 250));
  const saved = await fixture.store.load(sessionId);
  assert.ok(saved.timeline.some(item => item.kind === "user" && item.text === "Run the scheduled offline task") ||
    saved.webInbox?.pending.some(item => item.text === "Run the scheduled offline task"));
  const deleted = await call("schedule/deleteInactive");
  assert.equal(deleted.value.deleted, 2);
  assert.deepEqual((await call("schedule/catalog")).value, []);
  const connection = await connect();
  assert.equal((await call("schedule/create", { request: { title: "Foreign", prompt: "No", timing: { kind: "after", after_seconds: 1 }, target: { kind: "session", sessionId: fixture.foreign.id } } }, connection.connectionId)).ok, false);
});

test("binary file receipts are admitted and projected without exposing raw bytes", { timeout: 20_000 }, async t => {
  const fixture = await startWebFixture(harnessAssets);
  t.after(() => fixture.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const { call, headers } = harnessClient(fixture.url, controller.signal);
  const { value: { sessionId } } = await call("session/create");
  const url = new URL("/api/session/uploadFileBinary", fixture.url);
  url.search = new URLSearchParams({ sessionId, name: "archive.bin" }).toString();
  const response = await fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: Uint8Array.of(0, 255, 1), signal: controller.signal });
  const uploaded = await response.json();
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.value.file.mediaType, "application/octet-stream");
  const accepted = await call("session/prompt", { request: { sessionId, requestId: randomUUID(), content: [
    { type: "text", text: "Use this binary attachment" }, { type: "file", receiptId: uploaded.value.receiptId },
  ] } });
  assert.equal(accepted.ok, true);
  const saved = await fixture.store.load(sessionId);
  assert.equal(saved.webInbox?.pending.length, 1);
  assert.equal(saved.webInbox?.pending[0]?.uploadedFiles?.[0]?.mediaType, "application/octet-stream");
});

test("the stock directory picker adopts a workspace and keeps session and file requests in that workspace", { timeout: 35_000 }, async t => {
  let picked: string | null = null;
  const fixture = await startWebFixture(harnessAssets, false, 250, false, false, false, async () => picked);
  const controller = new AbortController();
  t.after(async () => { controller.abort(); await fixture.close(); });
  const sibling = join(dirname(fixture.workspace), "另一个项目");
  await mkdir(sibling);
  picked = await realpath(sibling);
  await writeFile(join(sibling, "SECOND.txt"), "Second workspace only");
  const saved = await fixture.store.create({
    title: "Existing second workspace session", titlePending: false, workspacePath: sibling, model: fixture.terminal.model,
  });

  const client = harnessClient(fixture.url, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
  const owner = await client.connect();
  const foreign = await client.connect();
  const events = await owner.subscribe("$events");
  const { clientId } = await owner.until(item => item.type === "ready", events);
  const feed = await owner.subscribe("workspace/follow");
  await owner.until(item => item.type === "baseline", feed);
  const adopt = (connectionId: string) => client.call("workspace/create", { request: { path: picked } }, connectionId);
  assert.equal((await adopt(owner.connectionId)).ok, false);
  assert.equal((await client.call("directoryPicker/pick", {}, owner.connectionId)).value, picked);
  assert.equal((await adopt(foreign.connectionId)).ok, false);
  const opened = await adopt(owner.connectionId);
  assert.equal(opened.value.created, true);
  const { workspaceId, sessionIds } = opened.value.workspace;
  assert.deepEqual(sessionIds, [saved.id]);
  assert.equal((await adopt(owner.connectionId)).value.created, false);
  const replacement = await owner.until(item => item.type === "replace", feed);
  assert.equal((replacement.value as { items: unknown[] }).items.length, 2);
  const listed = (await client.call("session/list")).value.items as Array<{ sessionId: string }>;
  assert.deepEqual(new Set(listed.map(session => session.sessionId)), new Set([fixture.terminal.id, saved.id]));
  assert.equal((await client.call("session/create", { workspaceId, sessionId: fixture.terminal.id })).ok, false);
  assert.equal((await client.call("session/create", { workspaceId, cwd: fixture.workspace })).ok, false);
  assert.deepEqual((await client.call("workspace/insertBefore", { workspaceId, beforeWorkspaceId: "everpeace-local" })).value.workspaceIds,
    [workspaceId, "everpeace-local"]);

  const scope = { workspaceFileScopeId: saved.id };
  if (process.platform === "win32") {
    assert.equal((await client.call("workspaceFiles/read", { ...scope, path: "SECOND.txt" })).value.text, "Second workspace only");
    assert.equal((await client.call("workspaceFiles/read", { ...scope, path: join(fixture.workspace, "README.md") })).error.code, "workspace-file/outside-workspace");
  }
  const prompt = await client.call("session/prompt", {
    sessionId: saved.id, requestId: randomUUID(), content: [{ type: "text", text: "Run the offline tool in the second workspace" }],
  });
  assert.equal(prompt.ok, true);
  const approval = await owner.until(item => item.event === "approval/request" && item.agentId === saved.id, events);
  assert.deepEqual((await client.call("workspace/delete", { workspaceId })).value, { deleted: true });
  assert.equal((await client.call("session/projections", { sessionId: saved.id })).ok, true);
  assert.equal((await client.call("session/create", { workspaceId })).ok, false);
  assert.deepEqual(fixture.taskWorkspaces, [picked]);
  const result = { clientId, eventId: approval.eventId, outcome: { kind: "result", value: "allowed-once" } };
  assert.equal((await client.call("$events/result", result, foreign.connectionId)).ok, false);
  assert.equal((await client.call("$events/result", result, randomUUID())).ok, false);
  const unbound = await client.post({ operation: "call", endpoint: "$events/result", payload: { args: result } });
  assert.equal((await unbound.json()).ok, false);
  assert.equal((await client.call("$events/result", result, owner.connectionId)).ok, true);
  await owner.until(item => item.event === "api-session/status" && Array.isArray(item.args) && item.args[0] === saved.id && item.args[1] === false, events);
  assert.deepEqual(fixture.commands, ["echo offline"]);
  assert.equal((await client.call("directoryPicker/pick", {}, owner.connectionId)).value, picked);
  const readded = (await adopt(owner.connectionId)).value.workspace;
  assert.notEqual(readded.workspaceId, workspaceId);
  assert.deepEqual(readded.sessionIds, [saved.id]);
  assert.deepEqual((await client.call("workspace/insertBefore", {
    workspaceId: readded.workspaceId, beforeWorkspaceId: "everpeace-local",
  })).value.workspaceIds, [readded.workspaceId, "everpeace-local"]);

  await fixture.stop();
  const restarted = await fixture.createServer();
  t.after(() => restarted.close());
  const reopened = harnessClient(restarted.url);
  const reader = await reopened.connect();
  const restoredFeed = await reader.subscribe("workspace/follow");
  const restored = await reader.until(item => item.type === "baseline", restoredFeed);
  assert.deepEqual((restored.value as { items: Array<{ workspaceId: string }> }).items.map(item => item.workspaceId),
    [readded.workspaceId, "everpeace-local"]);
  assert.deepEqual((await reopened.call("workspace/delete", { workspaceId: readded.workspaceId })).value, { deleted: true });
  assert.equal((await reopened.call("session/projections", { sessionId: saved.id })).ok, true);
  assert.ok((await fixture.store.load(saved.id)).timeline.some(entry => "text" in entry && entry.text.includes("Offline reply")));

  assert.equal((await reopened.call("directoryPicker/pick", {}, reader.connectionId)).value, picked);
  await rename(sibling, join(dirname(fixture.workspace), "previous-folder"));
  await mkdir(sibling);
  assert.equal((await reopened.call("workspace/create", { path: picked }, reader.connectionId)).ok, false);
});

test("parallel stock sessions keep their approvals, queues, transcripts and cancellation independent", { timeout: 35_000 }, async t => {
  const fixture = await startWebFixture(harnessAssets, true, 3_000);
  t.after(() => fixture.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const { call, connect } = harnessClient(fixture.url, AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]));
  const first = fixture.terminal.id;
  const owner = await connect();
  const events = await owner.subscribe("$events");
  const { clientId } = await owner.until(item => item.type === "ready", events);
  const transcript = async (sessionId: string) => {
    const reader = await connect();
    const feed = await reader.subscribe("session/follow", { request: { address: { kind: "session", sessionId } } });
    await reader.until(item => item.type === "snapshot", feed);
    return (predicate: Parameters<typeof reader.until>[0]) => reader.until(predicate, feed);
  };
  const followFirst = await transcript(first);
  const send = (sessionId: string, text: string) => call("session/prompt", { sessionId, requestId: randomUUID(), content: [{ type: "text", text }] });
  const approval = (sessionId: string) => owner.until(item => item.type === "waterfall" && item.event === "approval/request" && item.agentId === sessionId, events);
  assert.equal((await send(first, "Run the offline tool in the first session")).ok, true);
  const firstApproval = await approval(first);
  const created = await call("session/create", { workspaceId: "everpeace-local" });
  assert.equal(created.ok, true);
  const second = created.value.sessionId as string;
  const followSecond = await transcript(second);
  const catalog = (await call("session/modelCatalog")).value;
  assert.equal((await call("session/selectModel", { sessionId: second, provider: catalog.default.provider, model: "offline-pro" })).ok, true);
  assert.equal((await send(second, "Run the offline tool in the second session")).ok, true);
  const secondApproval = await approval(second);
  assert.notEqual(firstApproval.eventId, secondApproval.eventId);
  assert.deepEqual(fixture.commands, []);
  const list = (await call("session/list")).value.items as Array<{ sessionId: string; running: boolean }>;
  assert.deepEqual(new Set(list.filter(item => item.running).map(item => item.sessionId)), new Set([first, second]));
  const answerSecond = { clientId, eventId: secondApproval.eventId, outcome: { kind: "result", value: "allowed-once" } };
  const outsider = await connect();
  assert.equal((await call("$events/result", answerSecond, outsider.connectionId)).ok, false);
  assert.equal((await call("$events/result", answerSecond, owner.connectionId)).ok, true);
  assert.deepEqual(reason(await followSecond(isTurnEnd)), { kind: "completed" });
  assert.deepEqual(fixture.commands, ["echo offline"]);
  assert.equal((await send(first, "First queued message")).ok, true);
  assert.equal((await send(second, "Slow offline task in the second session")).ok, true);
  await followSecond(item => item.type === "assistant-stream" && (item.frame as { type?: string }).type === "chunk");
  const reconnect = await connect();
  const reconnectedEvents = await reconnect.subscribe("$events");
  await reconnect.until(item => item.type === "ready", reconnectedEvents);
  assert.equal((await reconnect.until(item => item.type === "waterfall" && item.agentId === first, reconnectedEvents)).eventId, firstApproval.eventId);
  assert.deepEqual((await call("session/cancel", { sessionId: first })).value, { accepted: true });
  assert.deepEqual(reason(await followFirst(isTurnEnd)), { kind: "aborted", reason: { kind: "user" } });
  assert.deepEqual(reason(await followSecond(isTurnEnd)), { kind: "completed" });
  const [firstSaved, secondSaved] = await Promise.all([fixture.store.load(first), fixture.store.load(second)]);
  assert.deepEqual(firstSaved.webInbox?.pending.map(item => item.text), ["First queued message"]);
  assert.equal(secondSaved.summary.model.id, "offline-pro");
  assert.doesNotMatch(JSON.stringify(firstSaved.timeline), /second session/u);
  assert.doesNotMatch(JSON.stringify(secondSaved.timeline), /first session|First queued message/u);
});

test("stock job controls observe and stop a task-owned production background command", { timeout: 35_000 }, async t => {
  const fixture = await startWebFixture(harnessAssets, true);
  t.after(() => fixture.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const { call, connect, post } = harnessClient(fixture.url, AbortSignal.any([controller.signal, AbortSignal.timeout(27_000)]));
  const sessionId = fixture.terminal.id;
  const other = (await call("session/create", { workspaceId: "everpeace-local" })).value.sessionId;
  const { subscribe, until, connectionId } = await connect();
  const roster = await subscribe("job/list", [{ sessionId }]);
  assert.deepEqual((await until(item => item.type === "rows", roster)).jobs, []);
  const events = await subscribe("$events");
  const { clientId } = await until(item => item.type === "ready", events);
  const address = { kind: "session", sessionId };
  const transcriptConnection = await connect();
  const transcript = await transcriptConnection.subscribe("session/follow", { request: { address } });
  await transcriptConnection.until(item => item.type === "snapshot", transcript);
  const prompt = await call("session/prompt", { sessionId, requestId: randomUUID(), content: [{ type: "text", text: "Run an offline background job" }] });
  assert.equal(prompt.ok, true);
  const approval = await until(item => item.type === "waterfall" && item.event === "approval/request", events);
  assert.deepEqual(fixture.commands, []);
  const approved = await call("$events/result", { clientId, eventId: approval.eventId, outcome: { kind: "result", value: "allowed-once" } });
  assert.equal(approved.ok, true);
  function jobRow(item: Record<string, unknown>) { return (item.jobs as Array<{ id: string; status: string; owner: string }>)?.[0]; }
  const row = jobRow(await until(item => item.type === "rows" && jobRow(item)?.status === "running", roster))!;
  assert.equal(row.owner, sessionId);
  const jobId = row.id;
  assert.equal((await call("job/kill", [{ sessionId: other, jobId }])).error.code, "job/not-found");
  const forbiddenFollow = await post({ operation: "subscribe", endpoint: "job/follow", connectionId, streamId: randomUUID(), payload: { args: [{ sessionId: other, jobId }] } });
  assert.equal(forbiddenFollow.status, 404);
  const otherRoster = await subscribe("job/list", [{ sessionId: other }]);
  assert.deepEqual((await until(item => item.type === "rows", otherRoster)).jobs, []);
  const feed = await subscribe("job/follow", [{ sessionId, jobId }]);
  assert.equal((await until(item => item.type === "opened", feed)).from, 0);
  const initial = await until(item => item.type === "output", feed);
  const chunks = initial.chunks as Array<{ text: string; channel: string }>;
  assert.match(chunks.map(chunk => chunk.text).join(""), /workbench-background-ready 后台/u);
  assert.ok(chunks.some(chunk => chunk.channel === "stderr" && chunk.text.includes("fixture-stderr")));
  assert.doesNotMatch(JSON.stringify(chunks), /sk-abcdefghijklmnopqrstuvwx|opaque-private-key-fixture/u);
  assert.equal(fixture.backgroundReleased(), false);
  assert.equal((await call("job/kill", [{ sessionId, jobId }])).value.outcome, "requested");
  await until(item => item.type === "rows" && jobRow(item)?.status === "stopping", roster);
  const finalOutput = await until(item => item.type === "output", feed);
  assert.match(JSON.stringify(finalOutput), /worker released/u);
  assert.equal(((await until(item => item.type === "status", feed)).job as { status: string }).status, "killed");
  assert.equal(fixture.backgroundReleased(), true);
  await until(item => item.type === "stream-end", feed);
  assert.equal((await call("job/kill", [{ sessionId, jobId }])).value.outcome, "already-finished");
  // Reopen from the last live byte offset after completion and see only its suffix.
  const resumed = await subscribe("job/follow", [{ sessionId, jobId, from: initial.next }]);
  assert.equal((await until(item => item.type === "opened", resumed)).from, initial.next);
  assert.match(JSON.stringify(await until(item => item.type === "output", resumed)), /worker released/u);
  assert.equal(((await until(item => item.type === "status", resumed)).job as { status: string }).status, "killed");
  assert.deepEqual(reason(await transcriptConnection.until(isTurnEnd, transcript)), { kind: "completed" });
});

test("job output reports retention loss and aligns resume offsets to UTF-8 boundaries", () => {
  const registry = new HarnessJobs("en");
  const observe = registry.observer(() => "owner");
  observe.started({ job_id: "job", command: "echo", started_at: new Date().toISOString() }, () => true);
  const line = "中".repeat(3_000) + "\n";
  for (let index = 0; index < 40; index++) observe.output("job", "stdout", line);
  observe.settled({ job_id: "job", status: "completed", exit_code: 0, finished_at: new Date().toISOString() }, false);
  const job = registry.get("owner", "job")!;
  assert.ok(job.output.earliest > 0);
  let finished = false;
  const frames: unknown[] = [];
  registry.follow(job, job.output.earliest + 1, frame => frames.push(frame), () => { finished = true; });
  const batches = frames.slice(1, -1) as Array<{ lossy?: true; chunks: Array<{ text: string; at: number }> }>;
  assert.equal(batches[0]?.lossy, true);
  assert.equal(batches[0]?.chunks[0]?.at, job.output.earliest + 3);
  assert.ok(batches.every(batch => Buffer.byteLength(batch.chunks.map(chunk => chunk.text).join("")) <= 64 * 1024));
  assert.doesNotMatch(JSON.stringify(frames), /�/u);
  assert.equal(finished, true);
});

test("stock skill commands use the scoped catalog and publish only successful invocations", { timeout: 40_000 }, async t => {
  const fixture = await startWebFixture(harnessAssets, false, undefined, false, true);
  t.after(() => fixture.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const { call, connect } = harnessClient(fixture.url, AbortSignal.any([controller.signal, AbortSignal.timeout(28_000)]));
  const sessionId = fixture.terminal.id;
  const address = { kind: "session", sessionId };
  const scope = { workspaceFileScopeId: sessionId };
  const secret = "sk-abcdefghijklmnopqrstuvwx";
  const external = await fixture.writeSkill("user", "external-demo", `# External Skill\nExample credential ${secret}`);
  await writeFile(join(dirname(external), "private.txt"), "outside the granted document");
  await fixture.writeSkill("repo", "collision", "Do not load this project copy.");
  await fixture.writeSkill("user", "collision", "Do not load this user copy.");
  await fixture.writeSkill("repo", "plan", "Do not override the command.");
  const catalog = await call("skills/list", { sessionId });
  assert.equal(catalog.ok, true);
  assert.deepEqual(catalog.value.skills.map((item: { name: string }) => item.name).sort(), ["external-demo", "user-demo", "workspace-demo"]);
  assert.equal((await call("skills/list", { sessionId: fixture.foreign.id })).ok, false);
  assert.equal(fixture.requests(), 0);
  assert.doesNotMatch(JSON.stringify(catalog), /invocation marker|Example credential/u);
  assert.equal((await call("workspaceFiles/read", { ...scope, path: join(dirname(external), "private.txt") })).error.code, "workspace-file/outside-workspace");
  assert.equal((await call("workspaceFiles/list", { ...scope, path: dirname(external) })).error.code, "workspace-file/outside-workspace");
  assert.equal((await call("workspaceFiles/readBytes", { ...scope, path: "private.txt", options: { baseFile: external } })).error.code, "workspace-file/outside-workspace");
  const externalTwin = await fixture.writeSkill("repo", "external-demo", "Conflicts with the external Skill.");
  assert.equal((await call("workspaceFiles/read", { ...scope, path: external })).error.code, "workspace-file/outside-workspace");
  await writeFile(externalTwin, "No longer a Skill\n");
  if (process.platform === "win32") {
    const projectPath = catalog.value.skills.find((item: { name: string }) => item.name === "workspace-demo").path;
    assert.match((await call("workspaceFiles/read", { ...scope, path: projectPath })).value.text, /Workspace Skill/u);
    const text = await call("workspaceFiles/read", { ...scope, path: external });
    assert.equal(text.ok, true, JSON.stringify(text.error));
    assert.match(text.value.text, /External Skill/u);
    assert.ok(!text.value.text.includes(secret));
    const bytes = await call("workspaceFiles/readBytes", { ...scope, path: external });
    assert.equal(bytes.ok, true, JSON.stringify(bytes.error));
    assert.ok(!Buffer.from(bytes.value.base64, "base64").toString().includes(secret));
  }
  let clientId: unknown;
  const { subscribe, until } = await connect(async item => {
    if (item.type !== "waterfall" || item.event !== "user-questions/request") return;
    const question = (item.request as { questions: Array<{ id: string; options: Array<{ label: string }> }> }).questions[0];
    if (question?.id !== "sensitive_access") return;
    const result = await call("$events/result", { clientId, eventId: item.eventId, outcome: {
      kind: "result", value: { answers: [{ id: question.id, selected: [question.options[0]!.label] }] },
    } });
    assert.equal(result.ok, true);
  });
  const wait = (label: string, predicate: Parameters<typeof until>[0], stream: string) => until(predicate, stream)
    .catch((cause: unknown) => { throw new Error(`Waiting for ${label} failed`, { cause }); });
  const feed = await subscribe("session/follow", { request: { address } });
  await wait("session snapshot", item => item.type === "snapshot", feed);
  const eventFeed = await subscribe("$events");
  ({ clientId } = await wait("event connection", item => item.type === "ready", eventFeed));
  const send = (text: string, mode = "queue") => call("session/prompt", { sessionId, mode, requestId: randomUUID(), content: [{ type: "text", text }] });
  const request = () => JSON.stringify([fixture.lastModelInput(), fixture.lastModelInstructions()]);
  assert.equal((await send("/workspace-demo Follow the selected skill")).ok, true);
  const invoked = await wait("skill invocation", item => item.type === "event" && JSON.stringify(item).includes('"kind":"skill-invocation"'), feed);
  assert.match(JSON.stringify(invoked), /workspace-demo/u);
  assert.doesNotMatch(JSON.stringify(invoked), /Workspace invocation marker/u);
  assert.deepEqual(reason(await wait("explicit skill turn", isTurnEnd, feed)), { kind: "completed" });
  assert.match(request(), /Workspace invocation marker\./u);
  assert.equal((await send("Do not activate /workspace-demo as part of this sentence.")).ok, true);
  assert.deepEqual(reason(await wait("plain-text skill mention", isTurnEnd, feed)), { kind: "completed" });
  assert.doesNotMatch(request(), /Workspace invocation marker\./u);
  assert.equal((await send("/collision This Skill is ambiguous")).ok, true);
  assert.deepEqual(reason(await wait("ambiguous skill turn", isTurnEnd, feed)), { kind: "completed" });
  assert.match(request(), /ambiguous/u);
  assert.doesNotMatch(request(), /Do not load this (?:project|user) copy/u);
  assert.equal((await send("Run the offline tool")).ok, true);
  await wait("tool approval", item => item.type === "waterfall" && item.event === "approval/request", eventFeed);
  assert.equal((await send("/user-demo Steer here", "steer")).ok, true);
  assert.deepEqual(reason(await wait("steered skill turn", isTurnEnd, feed)), { kind: "completed" });
  assert.match(request(), /User invocation marker\./u);
  assert.deepEqual(fixture.commands, []);
  assert.equal((await send("Slow offline task")).ok, true);
  await wait("slow model stream", item => item.type === "assistant-stream" && (item.frame as { type?: string }).type === "chunk", feed);
  assert.equal((await send("/workspace-demo Use only if still available")).ok, true);
  await fixture.writeSkill("user", "workspace-demo", "New duplicate discovered during queue wait.");
  assert.deepEqual(reason(await wait("slow turn settlement", isTurnEnd, feed)), { kind: "completed" });
  assert.deepEqual(reason(await wait("queued skill turn", isTurnEnd, feed)), { kind: "completed" });
  assert.doesNotMatch(request(), /Workspace invocation marker|New duplicate discovered/u);
  const saved = await fixture.store.load(sessionId);
  assert.ok(saved.timeline.some(entry => entry.kind === "user" && entry.text === "/user-demo Steer here"));
  assert.deepEqual(saved.timeline.flatMap(entry => entry.kind === "system" && entry.web_skill_name ? [entry.web_skill_name] : []), ["workspace-demo", "user-demo"]);
  const replay = await call("session/events", { address });
  assert.equal(replay.value.records.filter((item: unknown) => JSON.stringify(item).includes('"kind":"skill-invocation"')).length, 2);
});

test("the launch model stays the default after another session uses a different model", { timeout: 15_000 }, async t => {
  const fixture = await startWebFixture(harnessAssets);
  t.after(() => fixture.close());
  await fixture.stop();
  const server = await fixture.createServer("offline-pro");
  try {
    const { call } = harnessClient(server.url);
    const catalog = (await call("session/modelCatalog")).value;
    const { provider } = catalog.default;
    assert.equal(catalog.default.model, "offline-pro");
    const oldModel = fixture.terminal.model.id;
    const selected = await call("session/selectModel", { sessionId: fixture.terminal.id, provider, model: oldModel });
    assert.equal(selected.value.selected.model, oldModel);
    assert.deepEqual((await call("session/modelCatalog")).value.default, catalog.default);
    const created = await call("session/create", { workspaceId: "everpeace-local" });
    assert.equal((await fixture.store.load(created.value.sessionId)).summary.model.id, "offline-pro");
    assert.equal((await fixture.store.load(fixture.terminal.id)).summary.model.id, oldModel);
    assert.equal(fixture.requests(), 0);
  } finally { await server.close(); }
});

test("a browser task can continue past untrusted MCP startup without starting the server", { timeout: 25_000 }, async t => {
  const fixture = await startWebFixture(harnessAssets, false, undefined, true);
  t.after(() => fixture.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const { call, connect } = harnessClient(fixture.url, controller.signal);
  const { subscribe, until } = await connect();
  const events = await subscribe("$events");
  const { clientId } = await until(item => item.type === "ready", events);
  const sessionId = fixture.terminal.id;
  const feed = await subscribe("session/follow", { request: { address: { kind: "session", sessionId } } });
  await until(item => item.type === "snapshot", feed);
  for (const proceed of [false, true]) {
    const prompt = await call("session/prompt", { sessionId, requestId: randomUUID(), content: [{ type: "text", text: "Use the configured model" }] });
    assert.equal(prompt.ok, true);
    const question = await until(item => item.type === "waterfall" && item.event === "user-questions/request", events);
    const request = question.request as { questions: Array<{ id: string; options: Array<{ label: string }> }> };
    const { id, options } = request.questions[0]!;
    assert.equal(id, "mcp_startup");
    assert.equal(fixture.requests(), 0);
    const answer = await call("$events/result", { clientId, eventId: question.eventId, outcome: {
      kind: "result", value: { answers: [{ id, selected: [options[proceed ? 0 : 1]!.label] }] },
    } });
    assert.equal(answer.ok, true);
    const end = await until(isTurnEnd, feed);
    assert.equal((reason(end) as { kind: string }).kind, proceed ? "completed" : "error");
    assert.equal(fixture.requests(), proceed ? 1 : 0);
    assert.equal(fixture.mcpStarts(), 0);
  }
  const stored = await fixture.store.load(sessionId);
  assert.ok(stored.timeline.some(entry => entry.kind === "assistant" && entry.text.includes("Offline reply")));
  assert.ok(fixture.modelToolLists[0]!.every(name => !name.startsWith("mcp__")));
});

test("upstream RPC creates an Everpeace session, follows the transcript, and gates the real tool", { timeout: 45_000 }, async t => {
  const fixture = await startWebFixture(harnessAssets, true);
  t.after(() => fixture.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const { call, post, headers, connect } = harnessClient(fixture.url, controller.signal);
  assert.equal((await post({ operation: "call", endpoint: "session/list" }, { ...headers, Authorization: "" })).status, 401);
  const initial = await call("session/list");
  assert.deepEqual(initial.value.items.map((item: { sessionId: string }) => item.sessionId), [fixture.terminal.id]);
  const { subscribe, until, connectionId } = await connect();
  const events = await subscribe("$events");
  const { clientId } = await until(item => item.type === "ready", events);
  const workspace = await subscribe("workspace/follow");
  await until(item => item.type === "baseline", workspace);
  const created = await call("session/create", { request: { workspaceId: "everpeace-local" } });
  assert.equal(created.ok, true);
  const { sessionId } = created.value;
  const session = await subscribe("session/follow", { request: { address: { kind: "session", sessionId } } });
  await until(item => item.type === "snapshot", session);
  const prompt = await call("session/prompt", { request: {
    sessionId, requestId: randomUUID(), content: [{ type: "text", text: "Run the offline tool" }],
  } });
  assert.deepEqual(prompt, { ok: true, value: { accepted: true } });
  const approval = await until(item => item.type === "waterfall" && item.event === "approval/request", events);
  assert.equal(approval.agentId, sessionId);
  assert.deepEqual(fixture.commands, []);
  const approvalResult = {
    clientId, eventId: approval.eventId, outcome: { kind: "result", value: "allowed-once" },
  };
  assert.equal((await call("$events/result", approvalResult)).ok, true);
  assert.equal((await call("$events/result", approvalResult)).ok, false);
  assert.equal((await until(item => item.type === "event" && JSON.stringify(item).includes("Offline reply"), session)).type, "event");
  const firstEnd = await until(item => item.type === "event" && JSON.stringify(item).includes("turn/end"), session);
  assert.deepEqual(reason(firstEnd), { kind: "completed" });
  assert.deepEqual(fixture.commands, ["echo offline"]);
  const stored = await fixture.store.load(sessionId);
  assert.match(stored.summary.title, /Run the offline tool/u);
  assert.ok(stored.timeline.some(entry => entry.kind === "assistant" && entry.text.includes("Offline reply")));

  const laterPrompt = "A newer turn that must stay in the source";
  assert.equal((await call("session/prompt", { request: {
    sessionId, requestId: randomUUID(), content: [{ type: "text", text: laterPrompt }],
  } })).ok, true);
  await until(item => item.type === "event" && JSON.stringify(item).includes("turn/end"), session);
  const { seq: atSeq } = firstEnd.event as { seq: number };
  const branchRequest = { request: { sessionId, atSeq } };
  assert.equal((await call("session/fork", branchRequest)).error.code, "session/fork-unavailable");
  assert.equal((await call("session/fork", { request: { sessionId, atSeq: atSeq - 1 } }, connectionId)).error.code, "session/fork-unavailable");
  const branch = await call("session/fork", branchRequest, connectionId);
  assert.equal(branch.ok, true, JSON.stringify(branch.error));
  const child = await fixture.store.load(branch.value.sessionId);
  const parent = await fixture.store.load(sessionId);
  assert.equal(child.summary.lineage?.parent_session_id, sessionId);
  assert.deepEqual(child.timeline.flatMap(entry => entry.kind === "user" ? [entry.text] : []), ["Run the offline tool"]);
  assert.ok(child.timeline.some(entry => entry.kind === "assistant" && entry.text.includes("Offline reply")));
  assert.deepEqual(child.timeline.at(-1), { kind: "system", text: "", web_turn_outcome: "no_changes" });
  assert.match(JSON.stringify(child.context), /Run the offline tool/u);
  assert.doesNotMatch(JSON.stringify(child.context), /A newer turn/u);
  assert.ok(parent.timeline.some(entry => entry.kind === "user" && entry.text === laterPrompt));

  assert.equal((await call("session/prompt", { request: {
    sessionId, requestId: randomUUID(), content: [{ type: "text", text: "Run the offline tool again" }],
  } })).ok, true);
  await until(item => item.type === "waterfall", events);
  const busy = await call("workspace/archiveSession", { request: { sessionId } });
  assert.equal(busy.error.code, "workspace/session-active");
  assert.deepEqual((await call("workspace/archiveSession", { request: { sessionId, stopActivity: true } })).value.archivedSessionIds,
    [sessionId]);
  const cancelled = { kind: "aborted", reason: { kind: "user" } };
  assert.deepEqual(reason(await until(isTurnEnd, session)), cancelled);
  const replay = await call("session/events", { request: { address: { kind: "session", sessionId } } });
  assert.deepEqual(reason(replay.value.records.filter(isTurnEnd).at(-1)), cancelled);
  assert.deepEqual(fixture.commands, ["echo offline"]);
});

test("workspace sidebar and appearance settings survive a workbench restart", { timeout: 20_000 }, async t => {
  const fixture = await startWebFixture(harnessAssets);
  t.after(() => fixture.close());
  const { call } = harnessClient(fixture.url);
  const sessionId = fixture.terminal.id;
  const rename = await call("session/rename", { request: { sessionId, title: "  Retained   work  " } });
  assert.equal(rename.value.title, "Retained work");
  assert.equal((await fixture.store.load(sessionId)).summary.title, "Retained work");
  const search = await call("session/search", { request: { query: "Saved before" } });
  assert.deepEqual(search.value.items.map((item: { sessionId: string }) => item.sessionId), [sessionId]);
  assert.deepEqual((await call("session/search", { request: { query: "Other workspace" } })).value.items, []);
  const fork = await call("session/fork", { request: { sessionId } });
  const childId = fork.value.sessionId;
  const child = await fixture.store.load(childId);
  assert.equal(child.summary.lineage?.parent_session_id, sessionId);
  assert.equal(child.timeline[0]?.kind, "assistant");
  assert.equal((await call("workspace/rename", { request: {
    workspaceId: "everpeace-local", title: "Coding workspace",
  } })).value.workspace.title, "Coding workspace");
  assert.deepEqual((await call("workspace/insertSessionBefore", { request: {
    workspaceId: "everpeace-local", sessionId, beforeSessionId: childId,
  } })).value.workspace.sessionIds, [sessionId, childId]);
  assert.equal((await call("workspace/pinSession", { request: { sessionId: fixture.foreign.id } })).ok, false);
  assert.deepEqual((await call("workspace/pinSession", { request: { sessionId: childId } })).value.pinnedSessionIds, [childId]);
  assert.deepEqual((await call("workspace/archiveSession", { request: { sessionId } })).value.archivedSessionIds, [sessionId]);
  assert.equal((await call("session/prompt", { request: {
    sessionId, requestId: randomUUID(), content: [{ type: "text", text: "Archived prompt" }],
  } })).ok, false);
  const theme = [{ op: "set", path: ["preference"], value: "dark" }, { op: "set", path: ["fontSize"], value: 18 }];
  const updateTheme = (ops: unknown, expectedRevision: number) => call("settings/mutate", { ns: "ui-theme", ops, expectedRevision });
  assert.deepEqual((await updateTheme(theme, 0)).value.user, { preference: "dark", fontSize: 18 });
  assert.equal((await updateTheme(theme, 0)).ok, false);
  assert.equal((await updateTheme([{ op: "set", path: ["fontSize"], value: 999 }], 1)).ok, false);

  await fixture.stop();
  const restarted = await fixture.createServer();
  try {
    const client = harnessClient(restarted.url);
    const { subscribe, until } = await client.connect();
    const stream = await subscribe("workspace/follow");
    const state = await until(item => item.type === "baseline", stream);
    assert.match(JSON.stringify(state.value), /Coding workspace/u);
    assert.deepEqual(state.value, {
      items: [assertWorkspace(state.value, [sessionId, childId])], archivedSessionIds: [sessionId], pinnedSessionIds: [childId],
    });
    const settings = (await client.call("settings/describe")).value.namespaces;
    const appearance = settings.find((entry: { ns: string }) => entry.ns === "ui-theme");
    assert.deepEqual(appearance.user, { preference: "dark", fontSize: 18 });
    assert.equal(appearance.value.codeFontSize, 11);
    assert.deepEqual((await client.call("workspace/unarchiveSession", { request: { sessionId } })).value.archivedSessionIds, []);
    const updated = await until(item => item.type === "replace", stream);
    assert.deepEqual((updated.value as { archivedSessionIds: string[] }).archivedSessionIds, []);
  } finally { await restarted.close(); }
});

test("the stock permission picker and default settings control production approvals without widening host policy", {
  timeout: 45_000,
}, async t => {
  const fixture = await startWebFixture(harnessAssets, true);
  t.after(() => fixture.close());
  fixture.setHostPermission("workspace-write");
  const controller = new AbortController();
  t.after(() => controller.abort());
  const client = harnessClient(fixture.url, AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]));
  const { call, connect } = client;
  const create = async () => {
    const result = await call("session/create", { request: { workspaceId: "everpeace-local" } });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return result.value.sessionId as string;
  };
  const selected = async (sessionId: string, source = client) =>
    (await source.call("session/projections", { request: { sessionId } })).value.values.permissions.currentValue;
  const select = (sessionId: string, preset: string) => call("permissionPresets/set", { request: { sessionId, preset } });
  const setDefault = (value: string, revision: number) =>
    call("settings/mutate", ["permission", [{ op: "set", path: ["defaultPreset"], value }], revision]);
  const initial = await call("permissionPresets/catalog");
  assert.deepEqual(initial.value.options.map((option: { value: string }) => option.value), ["read-only", "ask", "workspace-write"]);
  assert.equal(initial.value.defaultPreset, "workspace-write");
  const previousSession = await create();
  assert.equal((await setDefault("ask", 0)).value.value.defaultPreset, "ask");
  assert.equal((await setDefault("read-only", 0)).ok, false);
  assert.equal((await setDefault("danger-full-access", 1)).ok, false);
  assert.equal(await selected(previousSession), "workspace-write");

  const sessionId = await create();
  assert.equal(await selected(sessionId), "ask");
  const address = { kind: "session", sessionId };
  const { subscribe, until } = await connect();
  const feed = await subscribe("session/follow", { request: { address } });
  await until(item => item.type === "snapshot", feed);
  const events = await subscribe("$events");
  const { clientId } = await until(item => item.type === "ready", events);
  const send = (id: string, text = "Run the offline tool") => call("session/prompt", { request: {
    sessionId: id, requestId: randomUUID(), mode: "queue", content: [{ type: "text", text }],
  } });
  const approve = (eventId: unknown) => call("$events/result", { clientId, eventId, outcome: { kind: "result", value: "allowed-once" } });
  assert.equal((await send(sessionId)).ok, true);
  const approval = await until(item => item.type === "waterfall" && item.event === "approval/request", events);
  assert.equal((await select(sessionId, "danger-full-access")).ok, false);
  assert.equal((await select(fixture.foreign.id, "read-only")).ok, false);
  assert.equal((await call("commands/execute", { agentId: sessionId, line: "/permission read-only", submittedAttachments: [] })).value.result.kind, "success");
  assert.equal((await approve(approval.eventId)).ok, false);
  assert.match(JSON.stringify(reason(await until(isTurnEnd, feed))), /PERMISSION_CHANGED/u);
  assert.equal(await selected(sessionId), "read-only");
  assert.deepEqual(fixture.commands, []);
  const fork = await call("session/fork", { request: { sessionId } });
  assert.equal(fork.ok, true);
  assert.equal(await selected(fork.value.sessionId), "read-only");

  const readOnly = await create();
  assert.equal((await select(readOnly, "read-only")).value.currentValue, "read-only");
  const readOnlyFeed = await subscribe("session/follow", { request: { address: { kind: "session", sessionId: readOnly } } });
  await until(item => item.type === "snapshot", readOnlyFeed);
  assert.equal((await send(readOnly)).ok, true);
  const allowed = await until(item => item.type === "waterfall" && item.event === "approval/request", events);
  assert.equal((await approve(allowed.eventId)).ok, true);
  assert.deepEqual(reason(await until(isTurnEnd, readOnlyFeed)), { kind: "completed" });
  assert.deepEqual(fixture.commandProfiles, [":read-only"]);

  const auto = await create();
  assert.equal((await select(auto, "workspace-write")).value.currentValue, "workspace-write");
  const autoFeed = await subscribe("session/follow", { request: { address: { kind: "session", sessionId: auto } } });
  await until(item => item.type === "snapshot", autoFeed);
  assert.equal((await send(auto)).ok, true);
  assert.deepEqual(reason(await until(isTurnEnd, autoFeed)), { kind: "completed" });
  assert.deepEqual(fixture.commandProfiles, [":read-only", ":workspace"]);

  const interrupted = await create();
  assert.equal((await select(interrupted, "workspace-write")).ok, true);
  const interruptedFeed = await subscribe("session/follow", { request: { address: { kind: "session", sessionId: interrupted } } });
  await until(item => item.type === "snapshot", interruptedFeed);
  assert.equal((await send(interrupted, "Slow offline task. Run the offline tool")).ok, true);
  await until(item => item.type === "assistant-stream" && (item.frame as { type?: string }).type === "chunk", interruptedFeed);
  fixture.tighten();
  assert.match(JSON.stringify(reason(await until(isTurnEnd, interruptedFeed))), /PERMISSION_CHANGED/u);
  assert.deepEqual(fixture.commandProfiles, [":read-only", ":workspace"]);
  assert.equal(await selected(interrupted), "read-only");
  assert.equal((await select(interrupted, "workspace-write")).error.code, "permission/preset-unavailable");
  assert.equal((await setDefault("workspace-write", 1)).error.code, "permission/preset-unavailable");
  assert.equal((await call("permissionPresets/catalog")).value.defaultPreset, "read-only");
  assert.equal((await fixture.store.load(interrupted)).summary.web_permission_mode, "workspace-write");

  controller.abort();
  await fixture.stop();
  fixture.setHostPermission("workspace-write");
  const restarted = await fixture.createServer();
  t.after(() => restarted.close());
  const cold = harnessClient(restarted.url);
  assert.equal(await selected(sessionId, cold), "read-only");
  assert.equal((await cold.call("permissionPresets/catalog")).value.defaultPreset, "ask");
  assert.equal((await cold.call("commands/list", { agentId: sessionId })).value.some((item: { name: string }) => item.name === "permission"), true);
});

test("the stock Goal panel uses durable Everpeace lifecycle, revision and round controls", { timeout: 45_000 }, async t => {
  const fixture = await startWebFixture(harnessAssets, true);
  t.after(() => fixture.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const { call, connect } = harnessClient(fixture.url, AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]));
  const { subscribe, until } = await connect();
  const createSession = async () => {
    const { value } = await call("session/create", { request: { workspaceId: "everpeace-local" } });
    const id = value.sessionId as string;
    const stream = await subscribe("session/follow", { request: { address: { kind: "session", sessionId: id } } });
    await until(item => item.type === "snapshot", stream);
    return { id, stream };
  };
  const first = await createSession();
  const create = (agentId: string, objective: string, maxGoalRounds: number) =>
    call("goals/create", { agentId, request: { objective, maxGoalRounds } });
  const view = async (agentId: string) => (await call("goals/get", { agentId })).value;
  const mutate = (kind: string, agentId: string, goal: { id: string; revision: number }, request?: object) =>
    call(`goals/${kind}`, { agentId, ref: { id: goal.id, revision: goal.revision }, ...(request ? { request } : {}) });

  assert.equal((await create(fixture.foreign.id, "Other workspace", 2)).ok, false);
  assert.equal((await create(first.id, "Invalid round limit", 0)).ok, false);
  const created = await create(first.id, "Slow offline task for a Goal", 2);
  assert.equal(created.ok, true, JSON.stringify(created.error));
  await until(item => item.type === "assistant-stream" && (item.frame as { type?: string }).type === "chunk", first.stream);
  const active = await view(first.id);
  assert.equal(active.activation, "armed");
  assert.equal(active.roundsStarted, 1);
  assert.deepEqual(created.value.ref, { id: active.id, revision: active.revision });
  assert.equal((await mutate("pause", first.id, { ...active, revision: active.revision + 1 })).error.code, "goal/stale-revision");
  assert.equal((await view(first.id)).activation, "armed");

  const paused = await mutate("pause", first.id, active);
  assert.equal(paused.ok, true, JSON.stringify(paused.error));
  assert.equal(paused.value.phase, "paused");
  assert.equal(paused.value.activation, "disarmed");
  assert.deepEqual(reason(await until(isTurnEnd, first.stream)), { kind: "aborted", reason: { kind: "user" } });
  assert.equal(fixture.requests(), 1);
  assert.equal((await mutate("clear", first.id, active)).error.code, "goal/stale-revision");
  const edited = await mutate("edit", first.id, paused.value, { objective: "Revised offline objective" });
  assert.equal(edited.ok, true, JSON.stringify(edited.error));
  assert.equal(edited.value.objective, "Revised offline objective");
  assert.equal(edited.value.phase, "paused");
  assert.equal(edited.value.roundsStarted, 1);
  assert.equal((await mutate("resume", first.id, edited.value)).ok, true);
  assert.match(JSON.stringify(reason(await until(isTurnEnd, first.stream))), /GOAL_ROUND_LIMIT/u);
  assert.equal(fixture.requests(), 2);
  const exhausted = await view(first.id);
  assert.equal(exhausted.phase, "blocked");
  assert.equal(exhausted.roundsStarted, 2);
  assert.equal(exhausted.blockedReason.code, "goal-round-limit");
  assert.equal((await mutate("resume", first.id, exhausted)).ok, false);
  const saved = await fixture.store.load(first.id);
  assert.equal(saved.goal?.status, "blocked");
  assert.equal(saved.goal?.max_goal_rounds, 2);
  assert.equal(saved.workflow?.result, "no_changes");
  assert.equal((await call("commands/execute", { agentId: first.id, line: "/goal edit --rounds 3", submittedAttachments: [] })).value.result.kind, "success");
  const raised = await view(first.id);
  assert.equal(raised.maxGoalRounds, 3);
  assert.equal(raised.objective, exhausted.objective);
  assert.equal((await mutate("clear", first.id, raised)).ok, true);
  assert.equal((await view(first.id)), undefined);

  const second = await createSession();
  const start = await call("commands/execute", { agentId: second.id, line: "/goal Finish offline goal", submittedAttachments: [] });
  assert.equal(start.value.result.kind, "success");
  assert.deepEqual(reason(await until(isTurnEnd, second.stream)), { kind: "completed" });
  const done = await view(second.id);
  assert.equal(done.phase, "complete");
  assert.equal(done.roundsStarted, 1);
  assert.equal(fixture.requests(), 4);
  assert.equal((await fixture.store.load(second.id)).workflow?.result, "no_changes");

  await writeFile(join(fixture.workspace, "package.json"), "{}");
  const third = await createSession();
  const events = await subscribe("$events");
  const { clientId } = await until(item => item.type === "ready", events);
  assert.equal((await create(third.id, "Write a fixture for the offline goal", 2)).ok, true);
  const approval = await until(item => item.type === "waterfall" && item.event === "approval/request", events);
  assert.equal((await call("$events/result", { clientId, eventId: approval.eventId,
    outcome: { kind: "result", value: "allowed-once" } })).ok, true);
  assert.match(JSON.stringify(reason(await until(isTurnEnd, third.stream))), /UNVERIFIED/u);
  assert.match(await readFile(join(fixture.workspace, "README.md"), "utf8"), /approved-offline-plan/u);
  const incomplete = await view(third.id);
  assert.equal(incomplete.phase, "active");
  assert.equal(incomplete.activation, "disarmed");
  assert.equal(incomplete.roundsStarted, 1);
  assert.equal((await fixture.store.load(third.id)).workflow?.result, "unverified");
  assert.equal(fixture.requests(), 7);

  controller.abort();
  await fixture.stop();
  const restarted = await fixture.createServer();
  t.after(() => restarted.close());
  const cold = harnessClient(restarted.url);
  assert.equal((await cold.call("goals/get", { agentId: first.id })).value, undefined);
  assert.deepEqual((await cold.call("goals/get", { agentId: second.id })).value, done);
  assert.deepEqual((await cold.call("goals/get", { agentId: third.id })).value, incomplete);
  assert.equal(fixture.requests(), 7);
});

test("composer references and scoped uploads reach the production model context and survive replay", { timeout: 25_000 }, async t => {
  const fixture = await startWebFixture(harnessAssets);
  t.after(() => fixture.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const { call, connect, headers } = harnessClient(fixture.url, controller.signal);
  const { value: { sessionId } } = await call("session/create", { request: { workspaceId: "everpeace-local" } });
  assert.deepEqual((await call("commands/list", { agentId: sessionId })).value.map((command: { name: string }) => command.name),
    ["plan", "permission", "goal"]);
  await mkdir(join(fixture.workspace, "Nested files"));
  await writeFile(join(fixture.workspace, "Nested files", "notes.md"), "workspace reference");
  await writeFile(join(fixture.workspace, ".env"), "sensitive");
  const fileReferences = (query: string) => call("fileReferences/list", { agentId: sessionId, query });
  const sessionReferences = (query: string) => call("sessionReferenceResolver/candidates", { agentId: sessionId, query });
  assert.deepEqual((await fileReferences("Nested files/")).value, [{ path: "Nested files/notes.md", kind: "file" }]);
  assert.deepEqual((await fileReferences("notes")).value, [{ path: "Nested files/notes.md", kind: "file" }]);
  assert.deepEqual((await fileReferences("../")).value, []);
  assert.deepEqual((await fileReferences(".env")).value, []);
  const references = (await sessionReferences("terminal")).value;
  assert.equal(references.length, 1);
  assert.equal(references[0].sessionId, fixture.terminal.id);
  assert.deepEqual((await sessionReferences("Other workspace")).value, []);

  const upload = (name: string, content: Uint8Array, auth = headers.Authorization) => {
    const url = new URL("/api/session/uploadFileBinary", fixture.url);
    url.search = new URLSearchParams({ sessionId, name }).toString();
    return fetch(url, { method: "POST", headers: { ...headers, Authorization: auth, "Content-Type": "application/octet-stream" },
      body: Buffer.from(content), signal: controller.signal });
  };
  assert.equal((await upload("note.md", Buffer.from("forged upload"), "")).status, 401);
  assert.equal((await (await upload(".env", Buffer.from("sensitive"))).json()).ok, false);
  const binary = await (await upload("tiny.dat", Uint8Array.of(0, 255))).json();
  assert.equal(binary.ok, true);
  assert.equal((await (await upload("large.md", Buffer.alloc(32 * 1024 + 1, 65))).json()).ok, false);
  const { value: { receiptId, file } } = await (await upload("draft.md", Buffer.from("a unique uploaded paragraph"))).json();
  const part = { type: "file", receiptId };
  const send = (id: string, content: unknown[], requestId = randomUUID()) =>
    call("session/prompt", { request: { sessionId: id, requestId, content } });
  assert.equal((await send(fixture.terminal.id, [part])).error.details.reason, "FILE_NOT_STAGED");
  const foreignRef = "dsh-session:" + Buffer.from(JSON.stringify(fixture.foreign.id)).toString("base64url");
  assert.equal((await send(sessionId, [{ type: "text", text: `@[outside](${foreignRef})` }])).ok, false);
  assert.equal(fixture.requests(), 0);
  const { subscribe, until } = await connect();
  const feed = await subscribe("session/follow", { request: { address: { kind: "session", sessionId } } });
  await until(item => item.type === "snapshot", feed);
  const prompt = `Compare @"Nested files/notes.md" and ${references[0].mention}`;
  const requestId = randomUUID();
  assert.deepEqual(await send(sessionId, [{ type: "text", text: prompt }, part], requestId), { ok: true, value: { accepted: true } });
  const userEvent = await until(item => item.type === "event" && (item.event as { type?: string }).type === "user/message", feed);
  assert.match(JSON.stringify(userEvent), /draft\.md/u);
  await until(item => item.type === "event" && (item.event as { type?: string }).type === "turn/end", feed);
  assert.equal((await send(sessionId, [part], requestId)).ok, true);
  assert.equal((await send(sessionId, [part])).error.details.reason, "FILE_NOT_STAGED");
  const model = JSON.stringify(fixture.lastModelInput());
  assert.match(model, /a unique uploaded paragraph/u);
  assert.match(model, /Saved before opening the workbench/u);
  assert.doesNotMatch(model, /forged upload/u);
  const saved = await fixture.store.load(sessionId);
  const uploaded = saved.timeline.find(entry => entry.kind === "user");
  assert.ok(uploaded?.kind === "user");
  assert.equal(uploaded.text, prompt);
  assert.deepEqual(uploaded.input_files, [file]);
  assert.equal(uploaded.web_turn_started, true);
  const replay = await subscribe("session/follow", { request: { address: { kind: "session", sessionId } } });
  const snapshot = await until(item => item.type === "snapshot", replay);
  assert.match(JSON.stringify(snapshot), /draft\.md/u);
  assert.doesNotMatch(JSON.stringify(snapshot), /a unique uploaded paragraph/u);

  const fallback = await call("fileUploads/upload", {
    agentId: sessionId, request: { name: "standalone.txt", data: Buffer.from("file-only input").toString("base64") },
  });
  assert.equal(fallback.ok, true);
  assert.equal((await send(sessionId, [{ type: "file", receiptId: fallback.value.receiptId }])).ok, true);
  await until(item => item.type === "event" && (item.event as { type?: string }).type === "turn/end", feed);
  assert.match(JSON.stringify(fixture.lastModelInput()), /file-only input/u);
  const fileOnly = (await fixture.store.load(sessionId)).timeline.findLast(entry => entry.kind === "user");
  assert.ok(fileOnly?.kind === "user");
  assert.equal(fileOnly.text, "");
  assert.deepEqual(fileOnly.input_files, [fallback.value.file]);
  assert.equal(fileOnly.web_turn_started, true);
});

test("stock image uploads are scoped, queued, steered, sent to Go Responses and restored from a fork", { timeout: 35_000 }, async t => {
  const fixture = await startWebFixture(harnessAssets);
  const server = await fixture.createServer("deepseek-v4.1-flash");
  const controller = new AbortController();
  t.after(async () => { controller.abort(); await server.close(); await fixture.close(); });
  const { call, post, connect, headers } = harnessClient(server.url, controller.signal);
  const { value: { sessionId } } = await call("session/create");
  assert.deepEqual((await call("session/modelCatalog")).value.default, { provider: "OpenCode Go", model: "offline-go-flash" });
  const { subscribe, until, connectionId } = await connect();
  const feed = await subscribe("session/follow", { address: { kind: "session", sessionId } });
  await until(item => item.type === "snapshot", feed);
  const events = await subscribe("$events");
  const { clientId } = await until(item => item.type === "ready", events);
  const png = (background: string) => sharp({ create: { width: 1100, height: 550, channels: 3, background } }).png().toBuffer();
  const blue = await png("blue");
  const red = await png("red");
  const upload = (body: Uint8Array, name: string, mediaType = "image/png", auth = headers.Authorization) => {
    const url = new URL("/api/session/uploadFileBinary", server.url);
    url.search = new URLSearchParams({ sessionId, name, mediaType }).toString();
    return fetch(url, { method: "POST", headers: { ...headers, Authorization: auth, "Content-Type": "application/octet-stream" },
      body: Buffer.from(body), signal: controller.signal });
  };
  assert.equal((await upload(blue, "blue.png", "image/png", "")).status, 401);
  assert.equal((await (await upload(blue, "wrong.png", "image/jpeg")).json()).error.details.reason, "IMAGE_DECODE_FAILED");
  assert.equal((await (await upload(blue, "vector.svg", "image/svg+xml")).json()).error.details.reason, "IMAGE_TYPE_UNSUPPORTED");
  const { value: first } = await (await upload(blue, "blue.png")).json();
  const { value: second } = await (await upload(red, "red.png")).json();
  assert.ok(first?.image && second?.image);
  assert.deepEqual([first.image.mediaType, first.image.width, first.image.height], ["image/webp", 1024, 512]);
  const image = (id: string, attachment = first.image) => call("session/attachment", { sessionId: id, attachment });
  const send = (id: string, text: string, receiptId?: string) => call("session/prompt", {
    sessionId: id, requestId: randomUUID(), mode: "queue", content: [{ type: "text", text }, ...(receiptId ? [{ type: "file", receiptId }] : [])],
  });
  assert.equal((await image(sessionId)).ok, false);
  assert.equal((await send(fixture.terminal.id, "Wrong receipt scope", first.receiptId)).error.details.reason, "FILE_NOT_STAGED");
  assert.equal((await send(sessionId, "Run the offline tool")).ok, true);
  await until(item => item.type === "waterfall" && item.event === "approval/request", events);
  assert.equal((await send(sessionId, "Look at blue", first.receiptId)).ok, true);
  assert.equal((await send(sessionId, "Look at red", second.receiptId)).ok, true);
  const queue = (await call("session/projections", { sessionId })).value.values.inbox["next-turn"];
  assert.deepEqual(queue.map((item: { content: unknown[] }) => item.content[1]), [first, second].map(upload => ({ type: "image", attachment: upload.image })));
  const editQueue = (action: object) => call("session/updateQueue", { sessionId, itemId: queue[0].id, action });
  assert.equal((await editQueue({ kind: "edit", content: [{ type: "text", text: "Lose image" }] })).error.details.reason, "QUEUE_EDIT_NON_TEXT");
  const bytes = (await image(sessionId)).value.data;
  assert.ok(bytes.length);
  assert.equal((await image(sessionId, { ...first.image, width: 1 })).ok, false);
  assert.equal((await image(fixture.terminal.id)).ok, false);
  const unauth = await post({ operation: "call", endpoint: "session/attachment", payload: { args: { sessionId, attachment: first.image } } }, { ...headers, Authorization: "" });
  assert.equal(unauth.status, 401);
  assert.equal((await editQueue({ kind: "steer" })).ok, true);
  assert.deepEqual(reason(await until(isTurnEnd, feed)), { kind: "completed" });
  assert.match(JSON.stringify(fixture.lastModelInput()), /"type":"input_image","image_url":"data:image\/webp;base64,/u);
  assert.deepEqual(reason(await until(isTurnEnd, feed)), { kind: "completed" });
  const serialized = JSON.stringify(fixture.lastModelInput());
  const redBytes = (await image(sessionId, second.image)).value.data;
  assert.ok(serialized.includes(`data:image/webp;base64,${bytes}`));
  assert.ok(serialized.includes(`data:image/webp;base64,${redBytes}`));
  const saved = await fixture.store.load(sessionId);
  assert.deepEqual(saved.timeline.flatMap(entry => entry.kind === "user" ? entry.input_files ?? [] : []), [first.image, second.image]);
  assert.deepEqual(saved.webInbox?.pending, []);
  const log = await readFile(join(fixture.store.directory, `${sessionId}.jsonl`), "utf8");
  assert.match(log, /everpeace_input_image/u);
  assert.ok(!log.includes(bytes) && !log.includes(redBytes));
  const { value: { sessionId: childId } } = await call("session/fork", { sessionId });
  const reopened = await fixture.createServer("deepseek-v4.1-flash");
  t.after(() => reopened.close());
  const cold = harnessClient(reopened.url, controller.signal);
  assert.deepEqual((await cold.call("session/attachment", { sessionId: childId, attachment: first.image })).value, { attachment: first.image, data: bytes });
  const history = (await cold.call("session/page", { address: { kind: "session", sessionId: childId } })).value;
  assert.match(JSON.stringify(history), /"type":"image","attachment":/u);
  assert.equal((await call("session/selectModel", { sessionId, provider: "compatible.invalid", model: "offline-pro" })).ok, true);
  const { value: third } = await (await upload(blue, "retry.png")).json();
  assert.equal((await send(sessionId, "Unsupported", third.receiptId)).error.details.reason, "IMAGE_MODEL_UNSUPPORTED");
  assert.equal((await send(sessionId, "Continue with text")).ok, true);
  const consent = await until(item => item.type === "waterfall" && item.event === "user-questions/request", events);
  assert.equal((consent.request as { questions: Array<{ id: string }> }).questions[0]?.id, "sensitive_access");
  assert.equal((await call("$events/result", { clientId, eventId: consent.eventId, outcome: {
    kind: "result", value: { answers: [{ id: "sensitive_access", selected: ["Allow original once"] }] },
  } }, connectionId)).ok, true);
  await until(isTurnEnd, feed);
  assert.match(JSON.stringify(fixture.lastModelInput()), /Earlier image/u);
  assert.doesNotMatch(JSON.stringify(fixture.lastModelInput()), /data:image/u);
});

function assertWorkspace(value: unknown, sessions: string[]) {
  const workspace = (value as { items: Array<{ sessionIds: string[] }> }).items[0]!;
  assert.deepEqual(workspace.sessionIds, sessions);
  return workspace;
}

test("the upstream plan card reviews a read-only task and starts one verified coding task", { timeout: 45_000 }, async t => {
  const fixture = await startWebFixture(harnessAssets, true);
  t.after(() => fixture.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const { call, connect } = harnessClient(fixture.url, controller.signal);
  let { value: { sessionId } } = await call("session/create", { request: { workspaceId: "everpeace-local" } });
  const command = (line: string) => call("commands/execute", { agentId: sessionId, line, submittedAttachments: [] });
  const address = { kind: "session", sessionId };
  const { subscribe, until } = await connect();
  const events = await subscribe("$events");
  const { clientId } = await until(item => item.type === "ready", events);
  const feed = await subscribe("session/follow", { request: { address } });
  await until(item => item.type === "snapshot", feed);
  const mode = async () => (await call("session/projections", { request: { sessionId } })).value.values.plan.active;
  const end = () => until(item => item.type === "event" && (item.event as { type?: string }).type === "turn/end", feed);
  const review = () => until(item => item.type === "waterfall" && item.event === "user-questions/request", events);
  const reply = (eventId: unknown, outcome: object) => call("$events/result", { clientId, eventId, outcome });
  const choose = (eventId: unknown, selected: string, custom?: string) => reply(eventId, {
    kind: "result", value: { answers: [{ id: "plan-review", selected: [selected], ...(custom === undefined ? {} : { custom }) }] },
  });

  assert.equal((await command("/plan")).value.result.kind, "success");
  assert.equal(await mode(), true);
  assert.equal(fixture.requests(), 0);
  const prompt = "Prepare an offline implementation";
  assert.equal((await call("session/prompt", { request: { sessionId, requestId: randomUUID(),
    content: [{ type: "text", text: prompt }] } })).ok, true);
  const draft = await review();
  const request = draft.request as { questions: Array<{ detail: string; intent: { kind: string; callId: string } }> };
  assert.equal(request.questions[0]?.intent.kind, "plan-review");
  assert.match(request.questions[0]?.detail ?? "", /^# Offline draft/u);
  const page = await call("session/events", { request: { address } });
  assert.match(JSON.stringify(page.value), /exit_plan_mode/u);
  assert.match(JSON.stringify(page.value), new RegExp(request.questions[0]!.intent.callId, "u"));
  assert.equal(fixture.requests(), 1);
  assert.ok(fixture.modelToolLists[0]?.includes("submit_plan"));
  assert.equal(fixture.modelToolLists[0]?.includes("bash"), false);
  assert.equal(fixture.modelToolLists[0]?.includes("apply_patch"), false);
  assert.deepEqual(fixture.commands, []);
  assert.equal((await choose(draft.eventId, "Approve", "forged approval")).ok, false);
  assert.equal((await choose(draft.eventId, "Keep planning", "Include acceptance criteria")).ok, true);
  const revised = await review();
  assert.notEqual(revised.eventId, draft.eventId);
  assert.match(JSON.stringify(revised.request), /Revised offline plan/u);
  assert.match(JSON.stringify(fixture.lastModelInput()), /Include acceptance criteria/u);
  assert.equal((await choose(draft.eventId, "Approve")).ok, false);
  assert.equal((await choose(revised.eventId, "Approve")).ok, true);
  const implementation = await until(item => item.type === "waterfall" && item.event === "approval/request", events);
  assert.match(JSON.stringify(implementation.request), /approved-offline-plan/u);
  assert.match(JSON.stringify(fixture.lastModelInput()), /explicitly started in the browser.*Revised offline plan/u);
  assert.equal(await mode(), false);
  assert.deepEqual(fixture.commands, []);
  assert.equal((await reply(implementation.eventId, { kind: "result", value: "allowed-once" })).ok, true);
  assert.deepEqual(reason(await end()), { kind: "completed" });
  const expectedCommands = [planFixtureCommand, ...["typecheck", "lint", "test", "build"].map(name => `pnpm${process.platform === "win32" ? ".cmd" : ""} run ${name}`)];
  assert.deepEqual(fixture.commands, expectedCommands);
  const saved = await fixture.store.load(sessionId);
  assert.equal(saved.workflow?.result, "verified");
  assert.match(await readFile(join(fixture.workspace, "README.md"), "utf8"), /approved-offline-plan/u);
  assert.equal(fixture.requests(), 4);
  assert.equal(saved.usage.input_tokens, 8);
  assert.equal(saved.timeline.filter(entry => entry.kind === "tool" && entry.plan?.phase === "submitted").length, 2);
  assert.match(JSON.stringify((await call("session/events", { request: { address } })).value), /Revised offline plan/u);

  assert.equal((await command("/plan Continue planning from the original request")).value.result.kind, "success");
  const dismissed = await review();
  assert.equal((await reply(dismissed.eventId, { kind: "rejected", error: { code: "ASK_CANCELLED" } })).ok, true);
  assert.deepEqual(reason(await end()), { kind: "aborted", reason: { kind: "user" } });
  assert.equal(await mode(), true);
  assert.equal(fixture.requests(), 5);
  assert.deepEqual(fixture.commands, expectedCommands);
  assert.equal((await command("/plan off")).value.result.kind, "success");
  assert.equal(await mode(), false);

  const fresh = await call("session/create", { request: { workspaceId: "everpeace-local" } });
  sessionId = fresh.value.sessionId;
  const freshFeed = await subscribe("session/follow", { request: { address: { kind: "session", sessionId } } });
  await until(item => item.type === "snapshot", freshFeed);
  assert.equal((await command("/plan Review again under the current policy")).value.result.kind, "success");
  const expired = await review();
  assert.match(JSON.stringify(expired.request), /plan-review/u);
  fixture.tighten();
  const expiredReply = await choose(expired.eventId, "Approve");
  assert.equal(expiredReply.ok, true, JSON.stringify(expiredReply.error));
  const failed = reason(await until(isTurnEnd, freshFeed));
  assert.deepEqual(failed, {
    kind: "error", error: {
      code: "PERMISSION_CHANGED", message: "Permissions changed during this turn. Send a new message to continue under the current policy.",
    },
  });
  const replay = await call("session/events", { request: { address: { kind: "session", sessionId } } });
  assert.deepEqual(reason(replay.value.records.filter(isTurnEnd).at(-1)), failed);
  assert.equal(await mode(), true);
  assert.equal(fixture.requests(), 6);
  assert.deepEqual(fixture.commands, expectedCommands);
});

test("turn results remain open during resource cleanup and replay conservatively after restart", { timeout: 45_000 }, async t => {
  const fixture = await startWebFixture(harnessAssets);
  t.after(() => fixture.close());
  const held = fixture.holdCleanup();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const { call, connect } = harnessClient(fixture.url, controller.signal);
  const { value: { sessionId } } = await call("session/create", { request: { workspaceId: "everpeace-local" } });
  const address = { kind: "session", sessionId };
  const { subscribe, until } = await connect();
  const feed = await subscribe("session/follow", { request: { address } });
  await until(item => item.type === "snapshot", feed);
  const send = () => call("session/prompt", { request: { sessionId, requestId: randomUUID(), content: [{ type: "text", text: "Run one turn" }] } });
  try {
    assert.equal((await send()).ok, true);
    await held.entered;
    const during = await call("session/events", { request: { address } });
    assert.equal(during.value.records.some(isTurnEnd), false);
    assert.equal((await send()).ok, true);
    assert.equal(await fixture.store.activity.inspect(sessionId), "active");
  } finally {
    held.finish(new Error("provider cleanup fixture details"));
  }
  const failed = reason(await until(isTurnEnd, feed));
  assert.deepEqual(failed, { kind: "error", error: {
    code: "CLEANUP_FAILED", message: "Everpeace could not clean up a resource after this turn.",
  } });
  assert.equal(await fixture.store.activity.inspect(sessionId), "unknown");
  assert.equal((await send()).ok, false);
  const saved = await fixture.store.load(sessionId);
  assert.deepEqual(saved.timeline.at(-1), { kind: "system", text: "", web_turn_outcome: "cleanup_failed" });
  assert.equal(saved.webInbox?.pending.length, 1);
  assert.doesNotMatch(JSON.stringify(saved.timeline), /provider cleanup fixture details/u);
  await fixture.store.appendTimeline(fixture.terminal.id, { kind: "user", text: "Old turn" });
  await fixture.store.appendTimeline(fixture.terminal.id, { kind: "user", text: "Unsettled web turn", web_turn_started: true });
  controller.abort();
  await fixture.stop();
  const restarted = await fixture.createServer();
  t.after(() => restarted.close());
  const cold = harnessClient(restarted.url);
  const coldPage = await cold.call("session/events", { request: { address } });
  assert.deepEqual(coldPage.value.records.filter(isTurnEnd).map(reason), [failed]);
  const coldInbox = await cold.call("session/projections", { request: { sessionId } });
  assert.equal(coldInbox.value.values.inbox["next-turn"].length, 1);
  const legacy = await cold.call("session/events", { request: { address: { kind: "session", sessionId: fixture.terminal.id } } });
  const legacyReasons = legacy.value.records.filter(isTurnEnd).map(reason);
  assert.deepEqual(legacyReasons.slice(0, -1), [{ kind: "blocked" }, { kind: "blocked" }]);
  assert.deepEqual(legacyReasons.at(-1), { kind: "error", error: {
    code: "OUTCOME_UNKNOWN", message: "Everpeace has no saved result for this turn.",
  } });
});

test("the queue edits and removes drafts, promotes guidance at a production boundary, and drains in FIFO order", {
  timeout: 45_000,
}, async t => {
  const fixture = await startWebFixture(harnessAssets, true);
  const deadline = AbortSignal.timeout(25_000);
  t.after(() => fixture.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const { call, connect } = harnessClient(fixture.url, AbortSignal.any([controller.signal, deadline]));
  const { value: { sessionId } } = await call("session/create", { request: { workspaceId: "everpeace-local" } });
  const address = { kind: "session", sessionId };
  const { subscribe, until, connectionId } = await connect();
  const feed = await subscribe("session/follow", { request: { address } });
  await until(item => item.type === "snapshot", feed);
  const eventFeed = await subscribe("$events");
  const { clientId } = await until(item => item.type === "ready", eventFeed);
  function send(text: string, mode = "queue", requestId = randomUUID(), id = sessionId) {
    return call("session/prompt", { request: { sessionId: id, requestId, mode, content: [{ type: "text", text }] } });
  }
  const queue = async () => {
    const result = await call("session/projections", { request: { sessionId } });
    return result.value.values.inbox["next-turn"] as Array<{ id: string; content: { text: string }[] }>;
  };
  const edit = (itemId: string, action: object) => call("session/updateQueue", { request: { sessionId, itemId, action } });
  const steeringRequest = randomUUID();
  assert.equal((await send("Run the offline tool")).ok, true);
  const approval = await until(e => e.type === "waterfall" && e.event === "approval/request", eventFeed);
  assert.equal((await send("Change focus within this turn", "queue", steeringRequest)).ok, true);
  assert.equal((await send("Edit this before the next turn")).ok, true);
  assert.equal((await send("Remove this draft")).ok, true);
  assert.equal((await send("Change focus within this turn", "queue", steeringRequest)).ok, true);
  const [steering, followup, removed] = await queue();
  assert.deepEqual((await queue()).map(row => row.content[0]?.text), [
    "Change focus within this turn", "Edit this before the next turn", "Remove this draft",
  ]);
  const removedReply = await edit(removed!.id, { kind: "remove" });
  assert.equal(removedReply.ok, true);
  const edited = await edit(followup!.id, { kind: "edit", content: [{ type: "text", text: "Edited followup after the current turn" }] });
  assert.equal(edited.ok, true);
  assert.equal(fixture.requests(), 1);
  const deferred = await fixture.store.load(sessionId);
  assert.doesNotMatch(JSON.stringify(deferred.context), /Change focus|Edited followup|Remove this draft/u);
  assert.equal((await edit(steering!.id, { kind: "steer" })).ok, true);
  const stale = await call("$events/result", {
    clientId, eventId: approval.eventId, outcome: { kind: "result", value: "allowed-once" },
  });
  assert.equal(stale.ok, false);
  const firstEnd = await until(isTurnEnd, feed);
  assert.deepEqual(reason(firstEnd), { kind: "completed" });
  assert.deepEqual(reason(await until(isTurnEnd, feed)), { kind: "completed" });
  assert.deepEqual(fixture.commands, []);
  assert.equal(fixture.requests(), 3);
  assert.deepEqual(await queue(), []);

  const saved = await fixture.store.load(sessionId);
  assert.deepEqual(saved.timeline.flatMap(entry => entry.kind === "user" ? [entry.text] : []), [
    "Run the offline tool", "Change focus within this turn", "Edited followup after the current turn",
  ]);
  assert.match(JSON.stringify(saved.context), /Change focus within this turn/u);
  assert.doesNotMatch(JSON.stringify(saved.context), /Remove this draft|Edit this before the next turn/u);
  const { seq } = firstEnd.event as { seq: number };
  const child = await call("session/fork", { request: { sessionId, atSeq: seq } }, connectionId);
  assert.equal(child.ok, true, JSON.stringify(child.error));
  const forked = await fixture.store.load(child.value.sessionId);
  assert.match(JSON.stringify(forked.context), /Change focus within this turn/u);
  assert.doesNotMatch(JSON.stringify(forked.context), /Edited followup/u);
  assert.equal(forked.webInbox, undefined);

  const fresh = await call("session/create", { request: { workspaceId: "everpeace-local" } });
  const freshId = fresh.value.sessionId as string;
  const freshAddress = { kind: "session", sessionId: freshId };
  const freshFeed = await subscribe("session/follow", { request: { address: freshAddress } });
  await until(item => item.type === "snapshot", freshFeed);
  assert.equal((await send("Slow offline task", "queue", randomUUID(), freshId)).ok, true);
  await until(item => item.type === "assistant-stream" && (item.frame as { type?: string }).type === "chunk", freshFeed);
  assert.equal((await send("Replace the unfinished answer", "steer", randomUUID(), freshId)).ok, true);
  assert.deepEqual(reason(await until(isTurnEnd, freshFeed)), { kind: "completed" });
  assert.equal(fixture.requests(), 5);
  const replay = await call("session/events", { request: { address: freshAddress } });
  assert.equal(replay.value.records.filter(isTurnEnd).length, 1);
  assert.equal(replay.value.records.filter((item: { event: { type: string } }) => item.event.type === "user/message").length, 2);
  assert.deepEqual(await queue(), []);
});

test("workspace files use scoped native listing, text and byte previews, and invalidation", {
  timeout: 20_000, skip: process.platform !== "win32",
}, async t => {
  const fixture = await startWebFixture(harnessAssets);
  t.after(() => fixture.close());
  const client = harnessClient(fixture.url);
  const sessionId = fixture.terminal.id;
  const relative = "README.md";
  const filePath = join(fixture.workspace, relative);
  const scope = { workspaceFileScopeId: sessionId };
  assert.deepEqual((await client.call("workspaceFiles/list", { ...scope, path: "" })).value.entries, [{ name: relative, type: "file" }]);
  const page = (await client.call("workspaceFiles/read", { ...scope, path: filePath, range: { offset: 2, limit: 1 } })).value;
  assert.equal(page.text, "Second line.");
  assert.equal(page.lines, 1);
  assert.equal(page.eof, true);
  const bytes = (await client.call("workspaceFiles/readBytes", { ...scope, path: relative, options: { range: { offset: 2, length: 7 } } })).value;
  assert.equal(Buffer.from(bytes.base64, "base64").toString(), "Offline");
  assert.equal(bytes.eof, false);
  assert.equal(bytes.version, page.version);
  assert.equal((await client.call("workspaceFiles/read", { workspaceFileScopeId: fixture.foreign.id, path: relative })).ok, false);
  assert.equal((await client.call("workspaceFiles/read", { ...scope, path: "../outside.txt" })).error.code, "workspace-file/outside-workspace");
  assert.deepEqual((await client.call("workspaceFiles/search", { ...scope, request: { query: "Read", includeHidden: false } })).value.matches,
    [{ path: relative, type: "file" }]);
  const outside = join(dirname(fixture.workspace), "outside");
  await mkdir(outside);
  await writeFile(join(outside, "outside.txt"), "Outside scope");
  await symlink(outside, join(fixture.workspace, "linked"), "junction");
  const escaped = await client.call("workspaceFiles/read", { ...scope, path: "linked/outside.txt" });
  assert.equal(escaped.ok, false);
  await writeFile(join(fixture.workspace, ".env"), "PASSWORD=fixture-only");
  const protectedEntry = await client.call("workspaceFiles/readBytes", { ...scope, path: ".env" });
  assert.equal(protectedEntry.ok, false);
  const { subscribe, until } = await client.connect();
  const watcher = await subscribe("workspaceFiles/changes", { ...scope, path: relative });
  await until(item => item.kind === "ready", watcher);
  await writeFile(filePath, "# changed\n");
  const event = await until(item => item.kind === "change", watcher);
  assert.equal((event.change as { absolutePath: string }).absolutePath, filePath);
  assert.notEqual((event.change as { version: string }).version, page.version);
});
