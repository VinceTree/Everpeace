import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import lockfile from "proper-lockfile";
import { prepareToolOutput, type PreparedToolOutput } from "../../../src/agent/context-limits.js";
import { SessionStore } from "../../../src/storage/session-store.js";
import { SessionHistoryRuntime } from "../../../src/storage/session-history.js";
import { SessionOutputStorage, readToolOutputReferences, toolOutputAttachmentReference } from "../../../src/storage/session-outputs.js";

const model = { id: "fixture", model_name: "fixture", base_url: "https://example.test" };

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-outputs-"));
  const store = new SessionStore({ directory, createId: () => "session-a" });
  const session = await store.create({ title: "output fixture", titlePending: false, workspacePath: "C:\\repo", model });
  const filePath = path.join(directory, `${session.id}.jsonl`);
  const attachmentPath = (outputId: string) => path.join(directory, "outputs", session.id, `${outputId}.output`);
  const prepare = (prefix = "HEAD") => prepareToolOutput(`${prefix}\r\n  ${"中😀".repeat(8_000)}\nTAIL`, "shell");
  const commit = (prepared: PreparedToolOutput, callId = "call-1") => store.commitToolResult(session.id, { type: "function_call_output", call_id: callId, output: prepared.output }, prepared.attachment);
  return { directory, store, session, filePath, attachmentPath, prepare, commit, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test("durable attachment remains readable with the same ID after compaction and restart", async () => {
  const f = await fixture();
  try {
    const prepared = f.prepare();
    assert.ok(prepared.attachment);
    await f.commit(prepared);
    await f.store.compactContext(f.session.id, [{ role: "user", content: "Summary only" }], true, null);
    const restarted = new SessionStore({ directory: f.directory });
    const loaded = await restarted.load(f.session.id);
    assert.deepEqual(loaded.context, [{ role: "user", content: "Summary only" }]);
    const restored = await restarted.readToolOutput(f.session.id, prepared.attachment.output_id);
    assert.ok(restored);
    assert.equal(restored.output_id, prepared.attachment.output_id);
    assert.deepEqual(restored.bytes, prepared.attachment.bytes);
    assert.equal(restored.tool_name, "shell");
    const events = (await fs.readFile(f.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const result = events.find((event) => event.tool_output_attachment);
    assert.equal(result.tool_output_attachment.output_id, prepared.attachment.output_id);
    assert.equal(result.items.length, 1);
  } finally { await f.cleanup(); }
});

test("prepared outputs commit in invocation order and only the seventeenth commit evicts the oldest", async () => {
  const f = await fixture();
  try {
    const prepared = Array.from({ length: 17 }, (_, index) => f.prepare(`output-${index}`));
    for (let index = 0; index < 16; index++) await f.commit(prepared[index]!, `call-${index}`);
    const first = prepared[0]!.attachment!;
    assert.ok(await f.store.readToolOutput(f.session.id, first.output_id));
    // Preparing a fast later result has no disk or retention effect.
    await fs.stat(f.attachmentPath(first.output_id));
    await f.commit(prepared[16]!, "call-16");
    assert.equal(await f.store.readToolOutput(f.session.id, first.output_id), null);
    await assert.rejects(fs.stat(f.attachmentPath(first.output_id)), { code: "ENOENT" });
    assert.equal((await fs.readdir(path.dirname(f.attachmentPath(first.output_id)))).length, 16);
    const restarted = new SessionStore({ directory: f.directory });
    assert.equal(await restarted.readToolOutput(f.session.id, first.output_id), null);
    assert.ok(await restarted.readToolOutput(f.session.id, prepared[16]!.attachment!.output_id));
    const items = (await f.store.load(f.session.id)).context;
    assert.deepEqual(items.map((item) => item.call_id), Array.from({ length: 17 }, (_, index) => `call-${index}`));
  } finally { await f.cleanup(); }
});

test("attachment write failure cannot append a dangling model result", async (t) => {
  const f = await fixture();
  try {
    const previous = await fs.readFile(f.filePath, "utf8");
    const originalOpen = fs.open;
    const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith(".output")) throw new Error("fixture attachment write failed");
      return originalOpen(...args);
    });
    await assert.rejects(f.commit(f.prepare()), /fixture attachment write failed/u);
    mocked.mock.restore();
    assert.equal(await fs.readFile(f.filePath, "utf8"), previous);
  } finally { await f.cleanup(); }
});

test("failed result append preserves committed outputs and startup removes only the orphan", async (t) => {
  const f = await fixture();
  try {
    const first = f.prepare("committed");
    await f.commit(first);
    const originalAppend = fs.appendFile;
    const failed = f.prepare("orphan");
    assert.ok(failed.attachment);
    const mocked = t.mock.method(fs, "appendFile", async (...args: Parameters<typeof fs.appendFile>) => {
      if (String(args[0]) === f.filePath) throw new Error("fixture reference append failed");
      return originalAppend(...args);
    });
    await assert.rejects(f.commit(failed), /fixture reference append failed/u);
    mocked.mock.restore();
    await assert.rejects(fs.stat(f.attachmentPath(failed.attachment.output_id)), { code: "ENOENT" });
    assert.ok(await f.store.readToolOutput(f.session.id, first.attachment!.output_id));
    assert.equal(await f.store.readToolOutput(f.session.id, failed.attachment.output_id), null);
    // A crash before best-effort cleanup can still leave an unreferenced artifact.
    await new SessionOutputStorage(f.directory).write(f.session.id, failed.attachment);
    const restarted = new SessionStore({ directory: f.directory });
    await restarted.captureSessionBoundary(f.session.id);
    await assert.rejects(fs.stat(f.attachmentPath(failed.attachment.output_id)), { code: "ENOENT" });
    assert.ok(await restarted.readToolOutput(f.session.id, first.attachment!.output_id));
  } finally { await f.cleanup(); }
});

test("session boundary waits for queued commits and deletion serializes sidecar cleanup", async () => {
  const f = await fixture();
  try {
    const prepared = f.prepare();
    const pendingCommit = f.commit(prepared);
    const boundary = f.store.captureSessionBoundary(f.session.id);
    await pendingCommit;
    assert.equal(await boundary, (await fs.stat(f.filePath)).size);
    const pendingSecond = f.commit(f.prepare("second"), "call-2");
    const deletion = f.store.deleteMany([f.session.id, f.session.id]);
    assert.equal(await f.store.readToolOutput(f.session.id, prepared.attachment!.output_id), null);
    await pendingSecond;
    await deletion;
    await assert.rejects(fs.stat(f.filePath), { code: "ENOENT" });
    await assert.rejects(fs.stat(path.dirname(f.attachmentPath(prepared.attachment!.output_id))), { code: "ENOENT" });
    await assert.rejects(f.commit(f.prepare()), /deleted/u);
  } finally { await f.cleanup(); }
});

test("legacy output IDs are unavailable and arbitrary envelope text cannot authorize an orphan", async () => {
  const f = await fixture();
  try {
    const prepared = f.prepare();
    await new SessionOutputStorage(f.directory).write(f.session.id, prepared.attachment!);
    await f.store.appendContext(f.session.id, [{ type: "function_call_output", call_id: "old", output: prepared.output }]);
    const restarted = new SessionStore({ directory: f.directory });
    assert.equal(await restarted.readToolOutput(f.session.id, prepared.attachment!.output_id), null);
    assert.equal(await restarted.readToolOutput(f.session.id, "old-process-id"), null);
    assert.equal(await restarted.readToolOutput(f.session.id, "../outside"), null);
    await assert.rejects(fs.stat(f.attachmentPath(prepared.attachment!.output_id)), { code: "ENOENT" });
    assert.equal((await restarted.load(f.session.id)).context.length, 1);
  } finally { await f.cleanup(); }
});

test("incomplete last append is ignored and corrupt middle logs prevent destructive cleanup", async () => {
  const f = await fixture();
  try {
    const prepared = f.prepare();
    await f.commit(prepared);
    const orphan = f.prepare("orphan");
    await new SessionOutputStorage(f.directory).write(f.session.id, orphan.attachment!);
    await fs.appendFile(f.filePath, '{"version":1,"type":"context_append"');
    const state = await readToolOutputReferences(f.filePath, f.session.id);
    assert.equal(state.safeToClean, true);
    assert.deepEqual(state.references.map((entry) => entry.output_id), [prepared.attachment!.output_id]);
    const restarted = new SessionStore({ directory: f.directory });
    assert.ok(await restarted.readToolOutput(f.session.id, prepared.attachment!.output_id));
    await assert.rejects(fs.stat(f.attachmentPath(orphan.attachment!.output_id)), { code: "ENOENT" });
    await new SessionOutputStorage(f.directory).write(f.session.id, orphan.attachment!);
    await fs.appendFile(f.filePath, '\n{"bad":}\n');
    const corrupt = new SessionStore({ directory: f.directory });
    assert.ok(await corrupt.readToolOutput(f.session.id, prepared.attachment!.output_id));
    await fs.stat(f.attachmentPath(orphan.attachment!.output_id));
  } finally { await f.cleanup(); }
});

test("attachment metadata tampering and oversize records never reach host consumers", async () => {
  const f = await fixture();
  try {
    const prepared = f.prepare();
    await f.commit(prepared);
    const outputPath = f.attachmentPath(prepared.attachment!.output_id);
    const raw = await fs.readFile(outputPath);
    const newline = raw.indexOf(10);
    const metadata = JSON.parse(raw.subarray(0, newline).toString("utf8"));
    metadata.tool_name = "other-tool";
    await fs.writeFile(outputPath, Buffer.concat([Buffer.from(`${JSON.stringify(metadata)}\n`), raw.subarray(newline + 1)]));
    assert.equal(await f.store.readToolOutput(f.session.id, prepared.attachment!.output_id), null);
    await fs.writeFile(outputPath, Buffer.alloc(3 * 1024 * 1024));
    assert.equal(await f.store.readToolOutput(f.session.id, prepared.attachment!.output_id), null);
  } finally { await f.cleanup(); }
});

test("output directories reject symbolic link substitution", async () => {
  const f = await fixture();
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-output-target-"));
  try {
    await fs.mkdir(path.join(f.directory, "outputs"));
    await fs.symlink(target, path.join(f.directory, "outputs", f.session.id), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(f.commit(f.prepare()), /regular directory/u);
    const restarted = new SessionStore({ directory: f.directory });
    await assert.rejects(restarted.load(f.session.id), /symbolic links/u);
    assert.deepEqual(await fs.readdir(target), []);
  } finally {
    await f.cleanup();
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("a second store cannot clean an attachment while its reference append is in flight", async (t) => {
  const f = await fixture();
  let resumeAppend!: () => void;
  const resume = new Promise<void>((resolve) => { resumeAppend = resolve; });
  let appendStarted!: () => void;
  const started = new Promise<void>((resolve) => { appendStarted = resolve; });
  const prepared = f.prepare();
  const originalAppend = fs.appendFile;
  const mocked = t.mock.method(fs, "appendFile", async (...args: Parameters<typeof fs.appendFile>) => {
    if (String(args[0]) === f.filePath && String(args[1]).includes(prepared.attachment!.output_id)) {
      appendStarted();
      await resume;
    }
    return originalAppend(...args);
  });
  try {
    const commit = f.commit(prepared);
    await started;
    const second = new SessionStore({ directory: f.directory });
    let completed = false;
    const read = second.readToolOutput(f.session.id, prepared.attachment!.output_id).then((value) => { completed = true; return value; });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(completed, false);
    await fs.stat(f.attachmentPath(prepared.attachment!.output_id));
    resumeAppend();
    await commit;
    assert.deepEqual((await read)?.bytes, prepared.attachment!.bytes);
    mocked.mock.restore();
    const later = f.prepare("later-store");
    await second.commitToolResult(f.session.id, { type: "function_call_output", call_id: "later", output: later.output }, later.attachment);
    assert.ok(await f.store.readToolOutput(f.session.id, later.attachment!.output_id));
  } finally {
    resumeAppend();
    mocked.mock.restore();
    await f.cleanup();
  }
});

test("startup finishes retention when a crash left the seventeenth reference committed", async () => {
  const f = await fixture();
  try {
    const prepared = Array.from({ length: 17 }, (_, index) => f.prepare(`crash-${index}`));
    for (let index = 0; index < 16; index++) await f.commit(prepared[index]!, `call-${index}`);
    const last = prepared[16]!;
    await new SessionOutputStorage(f.directory).write(f.session.id, last.attachment!);
    await fs.appendFile(f.filePath, `${JSON.stringify({
      version: 1, type: "context_append", at: new Date().toISOString(),
      items: [{ type: "function_call_output", call_id: "call-16", output: last.output }],
      tool_output_attachment: toolOutputAttachmentReference(last.attachment!),
    })}\n`);
    assert.equal((await fs.readdir(path.dirname(f.attachmentPath(last.attachment!.output_id)))).length, 17);
    const restarted = new SessionStore({ directory: f.directory });
    await restarted.captureSessionBoundary(f.session.id);
    assert.equal((await fs.readdir(path.dirname(f.attachmentPath(last.attachment!.output_id)))).length, 16);
    assert.equal(await restarted.readToolOutput(f.session.id, prepared[0]!.attachment!.output_id), null);
    assert.ok(await restarted.readToolOutput(f.session.id, last.attachment!.output_id));
    assert.equal((await readToolOutputReferences(f.filePath, f.session.id)).references.length, 16);
  } finally { await f.cleanup(); }
});

test("bounded history attachment reads use supplied validated metadata without scanning unrelated logs", async (t) => {
  const f = await fixture();
  try {
    const prepared = f.prepare();
    await f.commit(prepared);
    const cold = new SessionStore({ directory: f.directory });
    const originalReaddir = fs.readdir;
    const mocked = t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === path.join(f.directory, "outputs")) throw new Error("fixture must not initialize other sessions");
      return originalReaddir(...args);
    });
    assert.deepEqual((await cold.readReferencedToolOutput(f.session.id, toolOutputAttachmentReference(prepared.attachment!)))?.bytes, prepared.attachment!.bytes);
    mocked.mock.restore();
    await cold.deleteMany([f.session.id]);
    assert.equal(await cold.readReferencedToolOutput(f.session.id, toolOutputAttachmentReference(prepared.attachment!)), null);
  } finally { await f.cleanup(); }
});

test("bounded attachment reads honor deadlines and cancellation while another store holds the transaction lock", async () => {
  const f = await fixture();
  let release: (() => Promise<void>) | undefined;
  try {
    const prepared = f.prepare();
    await f.commit(prepared);
    const reference = toolOutputAttachmentReference(prepared.attachment!);
    const cold = new SessionStore({ directory: f.directory });
    release = await lockfile.lock(f.filePath, { realpath: false });
    const started = Date.now();
    await assert.rejects(cold.readReferencedToolOutput(f.session.id, reference, { deadline: Date.now() + 30 }), { name: "TimeoutError" });
    assert.ok(Date.now() - started < 1000);
    const controller = new AbortController();
    const pending = cold.readReferencedToolOutput(f.session.id, reference, { signal: controller.signal, deadline: Date.now() + 5000 });
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await release();
    release = undefined;
    assert.deepEqual((await cold.readReferencedToolOutput(f.session.id, reference))?.bytes, prepared.attachment!.bytes);
  } finally {
    await release?.();
    await f.cleanup();
  }
});

test("a recovered partial crash tail can continue through append or tool commit without changing earlier references", async () => {
  for (const mode of ["append", "commit"] as const) {
    const f = await fixture();
    try {
      await f.store.appendContext(f.session.id, [
        { role: "user", content: "stable before crash" },
        { type: "function_call", call_id: "first", name: "shell", arguments: "{}" },
      ]);
      const first = f.prepare("first retained");
      await f.commit(first, "first");
      await f.store.appendContext(f.session.id, [{ type: "function_call", call_id: "continued", name: "shell", arguments: "{}" }]);
      const history = new SessionHistoryRuntime({ store: f.store, workspacePath: "C:\\repo", sessionId: () => f.session.id });
      await history.prepareStep();
      const search = await history.call("session_event_search", '{"query":"stable before crash"}');
      const eventId = (search.matches as Array<Record<string, unknown>>)[0]!.event_id;
      const prefix = await fs.readFile(f.filePath);
      await fs.appendFile(f.filePath, '{"version":1,"type":"context_append","items":[');
      const restarted = new SessionStore({ directory: f.directory });
      assert.equal((await restarted.load(f.session.id)).context.length, 4);
      if (mode === "append") await restarted.appendContext(f.session.id, [{ role: "assistant", content: "continued after crash" }]);
      else {
        const continued = f.prepare("continued retained");
        await restarted.commitToolResult(f.session.id, { type: "function_call_output", call_id: "continued", output: continued.output }, continued.attachment);
        assert.ok(await restarted.readToolOutput(f.session.id, continued.attachment!.output_id));
      }
      const final = await fs.readFile(f.filePath);
      assert.deepEqual(final.subarray(0, prefix.byteLength), prefix);
      assert.equal((await restarted.load(f.session.id)).context.length, 5);
      assert.ok(await restarted.readToolOutput(f.session.id, first.attachment!.output_id));
      const restoredHistory = new SessionHistoryRuntime({ store: restarted, workspacePath: "C:\\repo", sessionId: () => f.session.id });
      await restoredHistory.prepareStep();
      assert.equal((await restoredHistory.call("session_event_read", JSON.stringify({ event_id: eventId }))).content, "stable before crash");
    } finally { await f.cleanup(); }
  }
});

test("a valid legacy final event without a newline keeps its text, attachment, and event reference", async () => {
  const f = await fixture();
  try {
    await f.store.appendContext(f.session.id, [{ type: "function_call", call_id: "valid-tail", name: "shell", arguments: "{}" }]);
    const first = f.prepare("valid-tail marker");
    await f.commit(first, "valid-tail");
    const history = new SessionHistoryRuntime({ store: f.store, workspacePath: "C:\\repo", sessionId: () => f.session.id });
    await history.prepareStep();
    const found = await history.call("session_event_search", '{"query":"valid-tail marker"}');
    const eventId = (found.matches as Array<Record<string, unknown>>)[0]!.event_id;
    const readArgs = JSON.stringify({ event_id: eventId, max_bytes: 1024 });
    const originalPage = await history.call("session_event_read", readArgs);
    const original = await fs.readFile(f.filePath);
    await fs.truncate(f.filePath, original.byteLength - 1);
    const legacy = original.subarray(0, -1);
    const restarted = new SessionStore({ directory: f.directory });
    assert.equal((await restarted.load(f.session.id)).context[1]!.output, first.output);
    assert.ok(await restarted.readToolOutput(f.session.id, first.attachment!.output_id));
    await restarted.appendContext(f.session.id, [{ role: "assistant", content: "continued valid legacy tail" }]);
    const final = await fs.readFile(f.filePath);
    assert.deepEqual(final.subarray(0, legacy.byteLength), legacy);
    assert.equal(final[legacy.byteLength], 10);
    assert.equal((await restarted.load(f.session.id)).context.length, 3);
    assert.ok(await restarted.readToolOutput(f.session.id, first.attachment!.output_id));
    const restoredHistory = new SessionHistoryRuntime({ store: restarted, workspacePath: "C:\\repo", sessionId: () => f.session.id });
    await restoredHistory.prepareStep();
    assert.deepEqual(await restoredHistory.call("session_event_read", readArgs), originalPage);
  } finally { await f.cleanup(); }
});

test("capturing a step repairs the partial tail before freezing its EOF", async () => {
  const f = await fixture();
  try {
    await f.store.appendContext(f.session.id, [{ role: "user", content: "before frozen repair" }]);
    const prefixSize = (await fs.stat(f.filePath)).size;
    await fs.appendFile(f.filePath, `{${"x".repeat(1000)}`);
    const restarted = new SessionStore({ directory: f.directory });
    const history = new SessionHistoryRuntime({ store: restarted, workspacePath: "C:\\repo", sessionId: () => f.session.id });
    await history.prepareStep();
    assert.equal((await fs.stat(f.filePath)).size, prefixSize);
    await restarted.appendContext(f.session.id, [{ role: "assistant", content: "later invisible to frozen step" }]);
    assert.deepEqual((await history.call("session_event_search", '{"query":"later invisible"}')).matches, []);
    await history.prepareStep();
    assert.equal(((await history.call("session_event_search", '{"query":"later invisible"}')).matches as unknown[]).length, 1);
  } finally { await f.cleanup(); }
});

test("an oversized unknown final record fails recovery without truncating legacy data", async () => {
  const f = await fixture();
  try {
    const unknown = `{"version":1,"type":"context_append","at":"now","items":[{"role":"user","content":"${"x".repeat(8 * 1024 * 1024)}"}]}`;
    await fs.appendFile(f.filePath, unknown);
    const original = await fs.readFile(f.filePath);
    const restarted = new SessionStore({ directory: f.directory });
    assert.equal((await restarted.load(f.session.id)).context.length, 1);
    await assert.rejects(restarted.appendContext(f.session.id, [{ role: "user", content: "later" }]), /8 MiB recovery limit/u);
    assert.deepEqual(await fs.readFile(f.filePath), original);
  } finally { await f.cleanup(); }
});
