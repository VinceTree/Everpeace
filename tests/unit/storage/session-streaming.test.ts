import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SessionStore } from "../../../src/storage/session-store.js";
import { PerformanceTrace } from "../../../src/performance/trace.js";
import { prepareToolOutput, readStoredToolOutput } from "../../../src/agent/context-limits.js";
import { toolOutputAttachmentReference } from "../../../src/storage/session-outputs.js";

const model = { id: "fixture", model_name: "fixture", base_url: "https://example.test" };

test("128 MiB replay retains final context and bounded raw records; list retains only summary", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-stream-replay-"));
  try {
    const trace = new PerformanceTrace();
    const store = new SessionStore({ directory, trace });
    const session = await store.create({ title: "large history", titlePending: false, workspacePath: directory, model });
    await store.appendTimeline(session.id, { kind: "user", text: "中文🙂\r\n  preserved" });
    const log = path.join(directory, `${session.id}.jsonl`);
    const handle = await fs.open(log, "a");
    const at = "2026-10-02T00:00:00.000Z";
    const append = JSON.stringify({ version: 1, type: "context_append", at, items: [{ role: "assistant", content: "x".repeat(1024 * 1024) }] });
    const compact = JSON.stringify({ version: 1, type: "context_compacted", at, items: [{ role: "user", content: "final context" }], automatic: true, usage: null });
    try {
      for (let index = 0; index < 128; index++) await handle.writeFile(`${append}\r\n${compact}\r\n`);
    } finally { await handle.close(); }
    assert.ok((await fs.stat(log)).size >= 128 * 1024 * 1024);
    const before = process.memoryUsage().heapUsed;
    const loaded = await store.load(session.id);
    assert.deepEqual(loaded.context, [{ role: "user", content: "final context" }]);
    assert.deepEqual(loaded.timeline, [{ kind: "user", text: "中文🙂\r\n  preserved" }]);
    assert.equal(loaded.usage.context_tokens, null);
    assert.deepEqual((await store.list()).sessions, [loaded.summary]);
    const metrics = trace.snapshot();
    assert.ok(metrics.counters.session_log_read_bytes! >= 256 * 1024 * 1024);
    assert.ok(metrics.counters.session_replay_max_record_bytes! < 1024 * 1024 + 1024);
    assert.ok(metrics.counters.session_replay_max_input_buffer_bytes! < 1024 * 1024 + 128 * 1024);
    // Heap varies by GC/platform; report it without turning wall time or GC into the gate.
    trace.observeMax("fixture_heap_before_bytes", before);
    trace.observeMax("fixture_heap_after_bytes", process.memoryUsage().heapUsed);
    console.log(JSON.stringify({ fixture: "session_replay_128mib", ...trace.snapshot() }));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("stream replay preserves huge legacy records, UTF-8 chunk boundaries and tail errors", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-stream-legacy-"));
  try {
    const store = new SessionStore({ directory });
    const session = await store.create({ title: "legacy", titlePending: false, workspacePath: directory, model });
    const content = `${"中🙂\r\n  ".repeat(900_000)}end`;
    await store.appendContext(session.id, [{ role: "user", content }]);
    const log = path.join(directory, `${session.id}.jsonl`);
    const tail = JSON.stringify({ version: 1, type: "title_updated", at: "2026-10-02T01:00:00.000Z", title: "valid tail" });
    await fs.appendFile(log, tail);
    const loaded = await store.load(session.id);
    assert.equal(loaded.context[0]?.content, content);
    assert.equal(loaded.summary.title, "valid tail");
    await fs.appendFile(log, "\n{unfinished");
    assert.equal((await store.load(session.id)).summary.title, "valid tail");
    await fs.appendFile(log, "\n");
    await assert.rejects(store.load(session.id), /Invalid session JSONL/u);
    assert.equal((await store.list()).skipped, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("100 Session listing and cold/warm search report deterministic read costs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-stream-list-"));
  try {
    const store = new SessionStore({ directory });
    const prepared = prepareToolOutput("retained diagnostic\n".repeat(3_000), "bash");
    assert.ok(prepared.attachment);
    let orphan = "";
    for (let index = 0; index < 100; index++) {
      const session = await store.create({ title: `session ${index}`, titlePending: false, workspacePath: directory, model });
      await store.appendContext(session.id, [{ role: "user", content: "context need not be retained by list" }]);
      await store.appendTimeline(session.id, { kind: "user", text: "search needle" });
      await store.appendContext(session.id, [{ type: "function_call", call_id: "diagnostic", name: "bash", arguments: "{}" }]);
      await store.commitToolResult(session.id, { type: "function_call_output", call_id: "diagnostic", output: prepared.output }, prepared.attachment);
      if (index === 0) {
        orphan = path.join(directory, "outputs", session.id, "orphan.output");
        await fs.writeFile(orphan, "crash leftover");
      }
    }
    const cold = new SessionStore({ directory });
    cold.performanceTrace.increment("attachment_read_bytes", 0);
    const start = performance.now();
    assert.equal((await cold.list()).sessions.length, 100);
    const listMs = performance.now() - start;
    const coldListCounters = cold.performanceTrace.snapshot().counters;
    assert.ok(coldListCounters.output_reference_scan_bytes! > 0);
    assert.equal(coldListCounters.attachment_read_bytes ?? 0, 0);
    await assert.rejects(fs.stat(orphan), { code: "ENOENT" });
    const warmListStart = performance.now();
    assert.equal((await cold.list()).sessions.length, 100);
    const warmListMs = performance.now() - warmListStart;
    const warmListCounters = cold.performanceTrace.snapshot().counters;
    assert.equal(warmListCounters.output_reference_scan_bytes, coldListCounters.output_reference_scan_bytes);
    assert.ok(warmListCounters.session_log_read_bytes! > coldListCounters.session_log_read_bytes!);
    const searchStart = performance.now();
    assert.equal((await cold.search({ query: "needle", workspacePath: directory, limit: 100 })).total, 100);
    const coldMs = performance.now() - searchStart;
    const warmStart = performance.now();
    assert.equal((await cold.search({ query: "needle", workspacePath: directory, limit: 100 })).total, 100);
    console.log(JSON.stringify({ fixture: "session_list_100", startup_list_ms: listMs, startup_list_counters: coldListCounters, warm_list_ms: warmListMs, warm_list_counters: warmListCounters, cold_search_ms: coldMs, warm_search_ms: performance.now() - warmStart, ...cold.performanceTrace.snapshot() }));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("v1 attachment pages equal full reads and 16 pages read at most 512 KiB", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-output-ranges-"));
  try {
    const store = new SessionStore({ directory });
    const session = await store.create({ title: "ranges", titlePending: false, workspacePath: directory, model });
    const prepared = prepareToolOutput("中🙂\r\n\"\\\t".repeat(250_000), "bash");
    assert.ok(prepared.attachment);
    const reference = toolOutputAttachmentReference(prepared.attachment);
    await store.appendContext(session.id, [{ type: "function_call", call_id: "large", name: "bash", arguments: "{}" }]);
    await store.commitToolResult(session.id, { type: "function_call_output", call_id: "large", output: prepared.output }, prepared.attachment);
    const baseline = store.performanceTrace.snapshot().counters.attachment_read_bytes ?? 0;
    let offset = 0;
    for (let index = 0; index < 16; index++) {
      const args = { output_id: reference.output_id, offset_bytes: offset, max_bytes: 24 * 1024 };
      const range = await store.readReferencedToolOutputPage(session.id, reference, args);
      assert.ok(range);
      const page = readStoredToolOutput(range, args);
      assert.deepEqual(page, readStoredToolOutput(prepared.attachment, args));
      assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 32 * 1024);
      offset = page.next_offset_bytes as number;
    }
    const bytes = store.performanceTrace.snapshot().counters.attachment_read_bytes! - baseline;
    assert.ok(bytes > 0 && bytes <= 512 * 1024, `attachment read ${bytes} bytes`);
    for (const position of [1, 2, 3, reference.retained_bytes - 1, reference.retained_bytes, reference.retained_bytes + 20]) {
      const args = { output_id: reference.output_id, offset_bytes: position, max_bytes: 5 };
      const range = await store.readReferencedToolOutputPage(session.id, reference, args);
      assert.ok(range);
      assert.deepEqual(readStoredToolOutput(range, args), readStoredToolOutput(prepared.attachment, args));
    }
    const tiny = { output_id: reference.output_id, offset_bytes: 0, max_bytes: 1 };
    const range = await store.readReferencedToolOutputPage(session.id, reference, tiny);
    assert.ok(range);
    assert.equal(readStoredToolOutput(range, tiny).status, "range_error");
    const file = path.join(directory, "outputs", session.id, `${reference.output_id}.output`);
    await fs.appendFile(file, "unexpected trailing data");
    assert.equal(await store.readReferencedToolOutputPage(session.id, reference, tiny), null);
    await store.deleteMany([session.id]);
    assert.equal(await store.readReferencedToolOutputPage(session.id, reference, tiny), null);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
