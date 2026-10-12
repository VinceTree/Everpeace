import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, appendFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../../../src/storage/session-store.js";
import { SessionPrivacy } from "../../../src/storage/session-privacy.js";
import { scanSensitiveText } from "../../../src/util/sensitive-scan.js";
import { redactSecretsPreservingLayout } from "../../../src/util/redact-secrets.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { observeProcessCompletion } from "../../../src/tools/process-completion.js";

test("TUI and Agent leases share ownership until every owner closes safely", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "everpeace-shared-lease-"));
  const store = new SessionStore({ directory: path.join(root, "sessions") });
  try {
    const [ui, agent] = await Promise.all([store.activity.acquire("shared"), store.activity.acquire("shared")]);
    await ui();
    agent.assertValid();
    assert.equal(await store.activity.inspect("shared"), "active");
    await agent();
    assert.equal(await store.activity.inspect("shared"), "closed");
    const [unsafe, safe] = await Promise.all([store.activity.acquire("unsafe"), store.activity.acquire("unsafe")]);
    await unsafe(false);
    await safe();
    assert.equal(await store.activity.inspect("unsafe"), "unknown");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows export accepts case aliases while rejecting linked destinations", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "everpeace-export-alias-"));
  const store = new SessionStore({ directory: path.join(root, "sessions") });
  const privacy = new SessionPrivacy(store, path.join(root, "privacy.json"));
  try {
    const session = await store.create({ title: "fixture", titlePending: false, workspacePath: root, model: { id: "fixture", model_name: "fixture", base_url: "https://fixture.invalid" } });
    await privacy.export(session.id, path.join(root.toUpperCase(), "summary.json"));
    assert.equal(JSON.parse(await readFile(path.join(root, "summary.json"), "utf8")).kind, "diagnostic_summary");
    const linked = path.join(root, "linked");
    const { symlink } = await import("node:fs/promises");
    await symlink(path.join(root, "sessions"), linked, "junction");
    await assert.rejects(privacy.export(session.id, path.join(linked, "unsafe.json")), /symbolic links/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cleanup excludes live/unknown sessions, refuses changed previews and removes only owned history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "everpeace-privacy-"));
  let now = new Date("2026-01-01T00:00:00Z");
  const store = new SessionStore({ directory: path.join(root, "sessions"), now: () => now });
  const privacy = new SessionPrivacy(store, path.join(root, "privacy.json"), () => now);
  const create = () => store.create({ title: "Private client title", titlePending: false, workspacePath: root, model: { id: "fixture", model_name: "fixture", base_url: "https://fixture.invalid" } });
  let release: (() => Promise<void>) | undefined;
  try {
    const closed = await create(); const active = await create(); const unknown = await create();
    const closeLease = await store.activity.acquire(closed.id); await closeLease();
    release = await store.activity.acquire(active.id);
    now = new Date("2026-05-01T00:00:00Z");
    const preview = await privacy.preview(30);
    assert.deepEqual(preview.candidates.map((c) => c.id), [closed.id]);
    assert.equal(preview.excluded.some((e) => e.id === active.id && e.reason === "active_session"), true);
    assert.equal(preview.excluded.some((e) => e.id === unknown.id && e.reason === "ownership_unknown"), true);
    await store.appendTimeline(closed.id, { kind: "user", text: "Concurrent change" });
    await assert.rejects(privacy.configure(preview.token), /preview changed/u);
    const fresh = await privacy.preview(30); await privacy.configure(fresh.token);
    assert.equal((await privacy.settings.read()).retentionDays, 30);
    await assert.rejects(store.deleteMany([active.id]), /already being held|locked/iu);
    await store.appendTimeline(active.id, { kind: "user", text: "Still usable after failed deletion" });
    assert.equal((await store.load(active.id)).timeline.length, 1);
    assert.equal((await privacy.autoCleanup())?.failed, 0);
    assert.equal(await privacy.autoCleanup(), undefined);
  } finally { await release?.(); await rm(root, { recursive: true, force: true }); }
});
test("default export is metadata only, refuses overwrite and scanner returns no secret fragments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "everpeace-export-"));
  const store = new SessionStore({ directory: path.join(root, "sessions") });
  const privacy = new SessionPrivacy(store, path.join(root, "privacy.json"));
  try {
    const session = await store.create({ title: "Customer title", titlePending: false, workspacePath: root, model: { id: "fixture", model_name: "fixture", base_url: "https://fixture.invalid" } });
    const fake = ["github", "_pat_", "SYNTHETIC".repeat(5)].join("");
    const text = `Customer source data\napi_key="${fake}"\nhttps://alice:test-password@example.invalid`;
    await store.appendTimeline(session.id, { kind: "user", text });
    const target = path.join(root, "diagnostic.json"); await privacy.export(session.id, target);
    assert.doesNotMatch(await readFile(target, "utf8"), /Customer|alice|test-password|SYNTHETIC|workspace_path/u);
    await assert.rejects(privacy.export(session.id, target), /exist/iu);
    assert.doesNotMatch(JSON.stringify(await privacy.scan(session.id)), /Customer|SYNTHETIC/u);
    assert.doesNotMatch(redactSecretsPreservingLayout(text), /SYNTHETIC|test-password/u);
    assert.equal(scanSensitiveText(text).length >= 2, true);
    await appendFile(path.join(store.directory, `${session.id}.jsonl`), "\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("another process holds an idle Session lease until its cleanup is confirmed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "everpeace-lease-"));
  const store = new SessionStore({ directory: path.join(root, "sessions") });
  const session = await store.create({ title: "fixture", titlePending: false, workspacePath: root, model: { id: "fixture", model_name: "fixture", base_url: "https://fixture.invalid" } });
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../fixtures/session-lease-worker.ts", import.meta.url)), store.directory, session.id], { detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const owner = observeProcessCompletion(child, { timeoutMs: 10_000 });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("error", reject); child.once("exit", () => reject(new Error("Lease fixture closed before admission"))); });
    const other = new SessionStore({ directory: store.directory });
    assert.equal(await other.activity.inspect(session.id), "active");
    await assert.rejects(other.deleteMany([session.id]), /locked|being held/iu);
    child.stdin!.write("close\n"); assert.equal((await owner.completion).exitCode, 0);
    assert.equal(await other.activity.inspect(session.id), "closed");
    await other.deleteMany([session.id]); await assert.rejects(store.load(session.id));
  } finally { owner.stop(); await owner.completion; await rm(root, { recursive: true, force: true }); }
});

test("conversation exports bind their preview and redact escaped and multiline credentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "everpeace-export-preview-"));
  const store = new SessionStore({ directory: path.join(root, "sessions") }); const privacy = new SessionPrivacy(store, path.join(root, "privacy.json"));
  try {
    const session = await store.create({ title: "fixture", titlePending: false, workspacePath: root, model: { id: "fixture", model_name: "fixture", base_url: "https://fixture.invalid" } });
    const key = ["-----BEGIN ", "RSA PRIVATE KEY-----\n", "SYNTHETIC-SECRET\n", "-----END RSA PRIVATE KEY-----"].join("");
    const content = JSON.stringify({ private_key: key, location: "https://test:synthetic-password@example.invalid/" }).replaceAll("/", "\\/");
    assert.ok(scanSensitiveText(content).some((match) => match.rule === "private_key")); assert.ok(scanSensitiveText(content).some((match) => match.rule === "url_credentials"));
    assert.doesNotMatch(redactSecretsPreservingLayout(content), /SYNTHETIC-SECRET|synthetic-password/u);
    await store.appendTimeline(session.id, { kind: "user", text: content });
    const preview = await privacy.previewExport(session.id);
    await store.appendTimeline(session.id, { kind: "assistant", text: "Changed after preview" });
    const target = path.join(root, "conversation.json"); await assert.rejects(privacy.export(session.id, target, true, preview.fingerprint), /changed/u);
    await assert.rejects(readFile(target));
    const fresh = await privacy.previewExport(session.id); await privacy.export(session.id, target, true, fresh.fingerprint);
    assert.doesNotMatch(await readFile(target, "utf8"), /SYNTHETIC-SECRET|synthetic-password/u);
    assert.match(await readFile(target, "utf8"), /Changed after preview/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("retained members remain excluded even when their own Session has no team summary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ep-retained-member-"));
  const store = new SessionStore({ directory: path.join(root, "sessions"), now: () => new Date("2026-01-01T00:00:00Z") });
  const privacy = new SessionPrivacy(store, path.join(root, "privacy.json"), () => new Date("2026-06-01T00:00:00Z"));
  try {
    const input = { title: "fixture", titlePending: false, model: { id: "fixture", model_name: "fixture", base_url: "https://provider.invalid" }, workspacePath: root };
    const owner = await store.create(input), member = await store.create(input);
    const close = await store.activity.acquire(member.id); await close();
    await Promise.all(Array.from({ length: 16 }, () => store.setTeam(owner.id, { teamId: "fixture", state: "stopped", members: [{ agentId: "worker", taskId: "task", sessionId: member.id, state: "done" }] })));
    const preview = await privacy.preview(30);
    assert.equal(preview.candidates.length, 0); assert.equal(preview.excluded.find((v) => v.id === member.id)?.reason, "retained_team_ownership");
    await assert.rejects(store.deleteMany([member.id], { [member.id]: "old-preview" }), /retained team/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
