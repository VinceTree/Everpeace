import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareToolOutput } from "../../../src/agent/context-limits.js";
import { SessionHistoryRuntime, SESSION_HISTORY_TOOL_DEFINITIONS, sessionHistoryBodyDigest } from "../../../src/storage/session-history.js";
import { SessionStore } from "../../../src/storage/session-store.js";

const model = { id: "test", model_name: "test-model", base_url: "https://example.invalid/v1" };

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-history-"));
  let serial = 0;
  let current: string | undefined;
  const store = new SessionStore({ directory, createId: () => `history-${++serial}` });
  const runtime = () => new SessionHistoryRuntime({ store, workspacePath: "c:/repo/", sessionId: () => current });
  const create = async (workspacePath = "C:\\repo", title = "Test history") => (await store.create({ workspacePath, title, titlePending: false, model })).id;
  return { directory, store, runtime, create, select: (id: string) => { current = id; }, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

function matches(result: Record<string, unknown>): Array<Record<string, unknown>> {
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.ok(Array.isArray(result.matches));
  return result.matches as Array<Record<string, unknown>>;
}

function relations(result: Record<string, unknown>): Array<Record<string, unknown>> {
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.ok(Array.isArray(result.relations));
  return result.relations as Array<Record<string, unknown>>;
}

async function attachLineage(
  directory: string,
  childId: string,
  parentId: string,
  forkedAt: string,
  sourceHeaderSha256?: string,
): Promise<void> {
  const parentFile = path.join(directory, `${parentId}.jsonl`);
  const childFile = path.join(directory, `${childId}.jsonl`);
  const [parent, child, parentStat] = await Promise.all([
    fs.readFile(parentFile),
    fs.readFile(childFile, "utf8"),
    fs.stat(parentFile),
  ]);
  const parentHeaderEnd = parent.indexOf(10);
  const headerBytes = parent.subarray(0, parentHeaderEnd < 0 ? parent.length : parentHeaderEnd);
  const lines = child.split("\n");
  const header = JSON.parse(lines[0]!) as Record<string, unknown>;
  header.lineage = {
    parent_session_id: parentId,
    forked_at: forkedAt,
    source_boundary_bytes: parentStat.size,
    source_header_sha256: sourceHeaderSha256 ?? createHash("sha256").update(headerBytes).digest("hex"),
  };
  lines[0] = JSON.stringify(header);
  await fs.writeFile(childFile, lines.join("\n"));
}

test("history schema exposes four read-only tools and bounded paging", () => {
  assert.deepEqual(SESSION_HISTORY_TOOL_DEFINITIONS.map((tool) => tool.name), ["session_search", "session_event_search", "session_event_read", "session_relations"]);
  assert.equal(SESSION_HISTORY_TOOL_DEFINITIONS[2].parameters.properties.max_bytes.maximum, 24 * 1024);
});

test("batch tool-result resolution is bound to the prepared EOF and rejects ambiguous origins", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.select(id);
    const output = "中文😀\r\n  stable diagnostic";
    await f.store.appendContext(id, [
      { type: "function_call", call_id: "stable", name: "bash", arguments: "{}" },
      { type: "function_call_output", call_id: "stable", output },
    ]);
    const runtime = f.runtime();
    await runtime.prepareStep();
    const candidate = {
      candidate_id: "candidate-1",
      call_id: "stable",
      tool_name: "bash",
      body_sha256: sessionHistoryBodyDigest(output),
    };
    const first = await runtime.resolveToolResults([candidate]);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.session_id, id);
    assert.match(first[0]?.event_id ?? "", /^history_/u);
    const read = await runtime.call("session_event_read", JSON.stringify({ event_id: first[0]?.event_id }));
    assert.equal(read.status, "ok");
    assert.equal(read.content, output);

    // The prepared step stays immutable even if an identical pair is appended.
    await f.store.appendContext(id, [
      { type: "function_call", call_id: "stable", name: "bash", arguments: "{}" },
      { type: "function_call_output", call_id: "stable", output },
    ]);
    assert.equal((await runtime.resolveToolResults([candidate])).length, 1);
    await runtime.prepareStep();
    assert.deepEqual(await runtime.resolveToolResults([candidate]), []);

    const memory = { ...candidate, candidate_id: "memory", tool_name: "memory_lookup" };
    const forged = { ...candidate, candidate_id: "forged", body_sha256: "0".repeat(64) };
    assert.deepEqual(await runtime.resolveToolResults([memory, forged]), []);
  } finally { await f.cleanup(); }
});

test("batch tool-result resolution fails closed across a damaged log interval", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.select(id);
    const output = "recoverable before corruption";
    await f.store.appendContext(id, [
      { type: "function_call", call_id: "damaged", name: "bash", arguments: "{}" },
      { type: "function_call_output", call_id: "damaged", output },
    ]);
    await fs.appendFile(path.join(f.directory, `${id}.jsonl`), "{damaged record}\n", "utf8");
    const runtime = f.runtime();
    await runtime.prepareStep();
    assert.deepEqual(await runtime.resolveToolResults([{
      candidate_id: "damaged",
      call_id: "damaged",
      tool_name: "bash",
      body_sha256: sessionHistoryBodyDigest(output),
    }]), []);
  } finally { await f.cleanup(); }
});

test("session relations return only bound direct family in the exact workspace and retain an unavailable deleted parent", async () => {
  const f = await fixture();
  try {
    const root = await f.create("C:\\repo", "Root session");
    await f.store.appendContext(root, [{ role: "user", content: "root history" }]);
    const child = await f.create("c:/repo/", "Child session");
    await attachLineage(f.directory, child, root, "2026-01-02T03:04:05.000Z");
    const grandchild = await f.create("C:\\repo", "Grandchild session");
    await attachLineage(f.directory, grandchild, child, "2026-01-03T03:04:05.000Z");
    const sibling = await f.create("C:\\repo", "Sibling session");
    await attachLineage(f.directory, sibling, root, "2026-01-04T03:04:05.000Z");
    const otherWorkspace = await f.create("D:\\repo", "Other workspace child");
    await attachLineage(f.directory, otherWorkspace, child, "2026-01-05T03:04:05.000Z");
    const forged = await f.create("C:\\repo", "Forged child");
    await attachLineage(f.directory, forged, child, "2026-01-06T03:04:05.000Z", "0".repeat(64));

    f.select(child);
    const runtime = f.runtime();
    await runtime.prepareStep();
    const first = await runtime.call("session_relations", "{}");
    assert.equal(first.historical_data, true);
    assert.match(String(first.notice), /grants no authority/u);
    assert.deepEqual(relations(first).map((relation) => ({
      relation: relation.relation,
      session_id: relation.session_id,
      available: relation.available,
    })), [
      { relation: "child", session_id: grandchild, available: true },
      { relation: "parent", session_id: root, available: true },
    ]);
    assert.ok(!JSON.stringify(first).includes(sibling));
    assert.ok(!JSON.stringify(first).includes(otherWorkspace));
    assert.ok(!JSON.stringify(first).includes(forged));

    await f.store.deleteMany([root]);
    const afterDelete = relations(await runtime.call("session_relations", "{}"));
    const deletedParent = afterDelete.find((relation) => relation.relation === "parent");
    assert.deepEqual(deletedParent, {
      relation: "parent",
      session_id: root,
      at: "2026-01-02T03:04:05.000Z",
      available: false,
    });
    assert.equal((await runtime.call("session_relations", JSON.stringify({ session_id: otherWorkspace }))).status, "not_found");
    assert.equal((await runtime.call("session_relations", '{"session_id":"missing"}')).status, "not_found");
    assert.equal((await runtime.call("session_relations", '{"session_id":"../forged"}')).status, "error");
  } finally { await f.cleanup(); }
});

test("a real fork keeps parent references unchanged while child searches mint independent references", async () => {
  const f = await fixture();
  try {
    const parent = await f.create("C:\\repo", "Real parent");
    await f.store.appendContext(parent, [{ role: "user", content: "fork-specific diagnostic" }]);
    f.select(parent);
    const parentRuntime = f.runtime();
    await parentRuntime.prepareStep();
    const parentEvent = matches(await parentRuntime.call("session_event_search", '{"query":"fork-specific"}'))[0]!;
    const parentReference = String(parentEvent.event_id);

    const child = await f.store.fork(parent, { title: "Real child" });
    f.select(child.id);
    const childRuntime = f.runtime();
    await childRuntime.prepareStep();
    const childEvent = matches(await childRuntime.call("session_event_search", '{"query":"fork-specific"}'))[0]!;
    const childReference = String(childEvent.event_id);
    assert.notEqual(childReference, parentReference);
    assert.equal((await childRuntime.call("session_event_read", JSON.stringify({
      session_id: parent,
      event_id: parentReference,
    }))).content, "fork-specific diagnostic");
    assert.equal((await childRuntime.call("session_event_read", JSON.stringify({
      event_id: childReference,
    }))).content, "fork-specific diagnostic");
    assert.deepEqual(relations(await childRuntime.call("session_relations", "{}")).map((relation) => ({
      relation: relation.relation,
      session_id: relation.session_id,
      available: relation.available,
    })), [{ relation: "parent", session_id: parent, available: true }]);

    await f.store.deleteMany([parent]);
    const unavailableParent = relations(await childRuntime.call("session_relations", "{}"))[0];
    assert.deepEqual({
      relation: unavailableParent?.relation,
      session_id: unavailableParent?.session_id,
      available: unavailableParent?.available,
    }, { relation: "parent", session_id: parent, available: false });
    assert.equal((await childRuntime.call("session_event_read", JSON.stringify({
      session_id: parent,
      event_id: parentReference,
    }))).status, "not_found");
    assert.equal((await childRuntime.call("session_event_read", JSON.stringify({
      event_id: childReference,
    }))).content, "fork-specific diagnostic");
  } finally { await f.cleanup(); }
});

test("original context survives compaction and durable step boundaries exclude later records", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.select(id);
    await f.store.appendContext(id, [{ role: "user", content: "Original parser decision" }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "Choose the Unicode parser" }] }]);
    await f.store.compactContext(id, [{ role: "assistant", content: "Duplicate parser summary" }], true, null);
    const runtime = f.runtime();
    await runtime.prepareStep();
    await f.store.appendContext(id, [{ role: "user", content: "Future parser decision" }]);
    const found = matches(await runtime.call("session_event_search", '{"query":"parser"}'));
    assert.equal(found.length, 2);
    assert.ok(found.every((match) => !String(match.snippet).includes("summary") && !String(match.snippet).includes("Future")));
    await runtime.prepareStep();
    assert.equal(matches(await runtime.call("session_event_search", '{"query":"Future"}')).length, 1);
    assert.equal((await f.runtime().call("session_event_search", '{"query":"parser"}')).status, "not_found");
  } finally { await f.cleanup(); }
});

test("workspace equality includes Windows drive/separator normalization and denies nested and other workspaces", async () => {
  const f = await fixture();
  try {
    const same = await f.create("C:\\repo", "Parser task");
    await f.store.updateTitle(same, "Updated parser task");
    await f.store.appendContext(same, [{ role: "user", content: "Body needle" }]);
    const other = await f.create("D:\\repo", "Parser task");
    const nested = await f.create("C:\\repo\\child", "Parser task");
    await f.store.appendContext(other, [{ role: "user", content: "Body needle" }]);
    await f.store.appendContext(nested, [{ role: "user", content: "Body needle" }]);
    const current = await f.create("c:/repo/", "Parser current");
    f.select(current);
    const runtime = f.runtime();
    await runtime.prepareStep();
    const found = matches(await runtime.call("session_search", '{"query":"parser"}'));
    assert.deepEqual(found.map((match) => match.session_id), [same]);
    assert.equal(found[0]!.title, "Updated parser task");
    assert.deepEqual(matches(await runtime.call("session_search", '{"query":"needle"}')).map((match) => match.session_id), [same]);
    for (const id of [other, nested, "../history-1", "missing"]) {
      const result = await runtime.call("session_event_search", JSON.stringify({ query: "needle", session_id: id }));
      assert.ok(result.status === "not_found" || result.status === "error");
    }
    const event = matches(await runtime.call("session_event_search", JSON.stringify({ query: "needle", session_id: same })))[0]!;
    assert.equal((await runtime.call("session_event_read", JSON.stringify({ event_id: event.event_id, session_id: other }))).status, "not_found");
    assert.equal((await runtime.call("session_event_read", JSON.stringify({ event_id: event.event_id, session_id: same }))).historical_data, true);
  } finally { await f.cleanup(); }
});

test("opaque references survive restart and append, but reject tampering, rewritten records and deletion", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.select(id);
    await f.store.appendContext(id, [{ role: "user", content: "Stable reference needle" }]);
    let runtime = f.runtime();
    await runtime.prepareStep();
    const event = matches(await runtime.call("session_event_search", '{"query":"needle"}'))[0]!;
    const eventId = String(event.event_id);
    assert.match(eventId, /^history_/u);
    assert.ok(!eventId.includes(f.directory));
    await f.store.appendContext(id, [{ role: "assistant", content: "New append" }]);
    runtime = new SessionHistoryRuntime({ store: new SessionStore({ directory: f.directory }), workspacePath: "C:\\repo", sessionId: () => id });
    await runtime.prepareStep();
    const read = await runtime.call("session_event_read", JSON.stringify({ event_id: eventId }));
    assert.equal(read.content, "Stable reference needle");
    assert.match(String(read.notice), /current permissions.*verification/u);
    const tampered = `${eventId.slice(0, -4)}AAAA`;
    assert.equal((await runtime.call("session_event_read", JSON.stringify({ event_id: tampered }))).status, "not_found");
    const decoded = JSON.parse(Buffer.from(eventId.slice(8), "base64url").toString("utf8"));
    decoded.item += 1;
    const ordinalTamper = `history_${Buffer.from(JSON.stringify(decoded)).toString("base64url")}`;
    assert.equal((await runtime.call("session_event_read", JSON.stringify({ event_id: ordinalTamper }))).status, "not_found");
    const filename = path.join(f.directory, `${id}.jsonl`);
    const original = await fs.readFile(filename, "utf8");
    await fs.writeFile(filename, original.replace("Stable reference needle", "Edited reference needle"));
    assert.equal((await runtime.call("session_event_read", JSON.stringify({ event_id: eventId }))).status, "not_found");
    await f.store.deleteMany([id]);
    assert.equal((await runtime.call("session_event_read", JSON.stringify({ event_id: eventId }))).status, "not_found");
  } finally { await f.cleanup(); }
});

test("function calls and retained omitted output are searchable and readable after restart", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.select(id);
    await f.store.appendContext(id, [{ type: "function_call", call_id: "call-1", name: "run_command", arguments: '{"command":"typecheck"}' }]);
    const body = `${"a".repeat(40 * 1024)}\nMiddle retained needle\n${"b".repeat(40 * 1024)}`;
    const prepared = prepareToolOutput(body, "run_command");
    assert.ok(prepared.attachment);
    assert.ok(!prepared.output.includes("Middle retained needle"));
    await f.store.commitToolResult(id, { type: "function_call_output", call_id: "call-1", output: prepared.output }, prepared.attachment);
    await f.store.compactContext(id, [{ role: "assistant", content: "Compacted" }], true, null);
    const runtime = new SessionHistoryRuntime({ store: new SessionStore({ directory: f.directory }), workspacePath: "C:\\repo", sessionId: () => id });
    await runtime.prepareStep();
    assert.equal(matches(await runtime.call("session_event_search", '{"query":"typecheck"}'))[0]!.kind, "tool_call");
    const event = matches(await runtime.call("session_event_search", '{"query":"Middle retained needle"}'))[0]!;
    assert.equal(event.output_id, prepared.attachment.output_id);
    const historical = await runtime.call("session_event_read", JSON.stringify({ event_id: event.event_id, max_bytes: 1024 }));
    assert.equal(historical.status, "ok");
    assert.equal(historical.output_id, prepared.attachment.output_id);
    assert.ok(!String(historical.content).includes("Middle retained needle"));
    const page = await runtime.readToolOutput(JSON.stringify({ output_id: prepared.attachment.output_id, offset_bytes: 40 * 1024, max_bytes: 1024 }));
    assert.equal(page.status, "ok");
    assert.match(String(page.content), /Middle retained needle/u);
    assert.equal(page.historical_data, true);
    assert.equal(page.at, event.at);
    assert.ok(!JSON.stringify(page).includes(f.directory));
  } finally { await f.cleanup(); }
});

test("read_tool_output requires a committed attachment before the frozen step and checks the workspace", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    const other = await f.create("D:\\other");
    f.select(id);
    await f.store.appendContext(id, [{ type: "function_call", call_id: "late", name: "run_command", arguments: "{}" }]);
    const prepared = prepareToolOutput("x".repeat(40_000), "run_command");
    const runtime = f.runtime();
    await runtime.prepareStep();
    await f.store.commitToolResult(id, { type: "function_call_output", call_id: "late", output: prepared.output }, prepared.attachment);
    const args = JSON.stringify({ output_id: prepared.attachment!.output_id });
    assert.equal((await runtime.readToolOutput(args)).status, "not_found");
    await runtime.prepareStep();
    assert.equal((await runtime.readToolOutput(args)).status, "ok");
    assert.equal((await runtime.readToolOutput(JSON.stringify({ output_id: prepared.attachment!.output_id, session_id: other }))).status, "not_found");
    assert.equal((await runtime.readToolOutput('{"output_id":"old-process-id"}')).status, "not_found");
    await f.store.deleteMany([id]);
    assert.equal((await runtime.readToolOutput(args)).status, "not_found");
  } finally { await f.cleanup(); }
});

test("history excludes reasoning, encrypted data, rules, Memory, host output and retrieval recursion", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.select(id);
    await f.store.appendContext(id, [
      { type: "reasoning", summary: [{ type: "summary_text", text: "excluded needle reasoning" }] },
      { role: "developer", content: "excluded needle rules" },
      { type: "compaction", encrypted_content: "excluded needle encrypted" },
      { type: "message", role: "assistant", content: [{ type: "reasoning_text", text: "excluded needle" }, { type: "output_text", text: "Visible response" }] },
    ]);
    await f.store.appendTimeline(id, { kind: "output", text: "excluded needle !host" });
    for (const name of ["memory_lookup", "session_search", "session_event_search", "session_event_read", "session_relations", "read_tool_output"]) {
      await f.store.appendContext(id, [{ type: "function_call", call_id: name, name, arguments: '{"query":"excluded needle"}' }]);
      const prepared = prepareToolOutput(`excluded needle ${"z".repeat(40_000)}`, name);
      await f.store.commitToolResult(id, { type: "function_call_output", call_id: name, output: prepared.output }, prepared.attachment);
    }
    const runtime = f.runtime();
    await runtime.prepareStep();
    assert.equal(matches(await runtime.call("session_event_search", '{"query":"excluded needle"}')).length, 0);
    assert.equal(matches(await runtime.call("session_event_search", '{"query":"Visible"}')).length, 1);
    const raw = await fs.readFile(path.join(f.directory, `${id}.jsonl`), "utf8");
    const result = JSON.parse(raw.trim().split("\n").at(-1)!);
    assert.equal((await runtime.readToolOutput(JSON.stringify({ output_id: result.tool_output_attachment.output_id }))).status, "not_found");
  } finally { await f.cleanup(); }
});

test("byte pagination preserves Chinese, emoji, CRLF and indentation while redacting before matching", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.select(id);
    const secret = "sk-abcdefghijklmnopqrstuv";
    await f.store.appendContext(id, [{ role: "user", content: `中文😀\r\n  api_key=${secret}\r\n    after` }]);
    const runtime = f.runtime();
    await runtime.prepareStep();
    const event = matches(await runtime.call("session_event_search", '{"query":"after"}'))[0]!;
    assert.ok(!JSON.stringify(event).includes(secret));
    const tiny = await runtime.call("session_event_read", JSON.stringify({ event_id: event.event_id, max_bytes: 1 }));
    assert.equal(tiny.status, "range_error");
    assert.equal(tiny.next_offset_bytes, undefined);
    let offset = 0;
    let text = "";
    for (let count = 0; count < 100; count += 1) {
      const read = await runtime.call("session_event_read", JSON.stringify({ event_id: event.event_id, offset_bytes: offset, max_bytes: 5 }));
      assert.equal(read.status, "ok", JSON.stringify(read));
      text += String(read.content);
      if (read.complete) break;
      assert.ok(Number(read.next_offset_bytes) > offset);
      offset = Number(read.next_offset_bytes);
    }
    assert.equal(text, "中文😀\r\n  api_key=[secret redacted]\r\n    after");
    assert.ok(!text.includes("�"));
    assert.equal((await runtime.call("session_event_read", JSON.stringify({ event_id: event.event_id, max_bytes: 25_000 }))).status, "error");
  } finally { await f.cleanup(); }
});

test("corrupt middle records are partial and unfinished final lines do not hide valid history", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.select(id);
    await f.store.appendContext(id, [{ role: "user", content: "first needle" }]);
    const filename = path.join(f.directory, `${id}.jsonl`);
    await fs.appendFile(filename, "not-json\n");
    await f.store.appendContext(id, [{ role: "assistant", content: "last needle" }]);
    await fs.appendFile(filename, '{"version":1');
    const runtime = f.runtime();
    await runtime.prepareStep();
    const result = await runtime.call("session_event_search", '{"query":"needle"}');
    assert.equal(matches(result).length, 2);
    assert.equal(result.incomplete, true);
    assert.ok((result.incomplete_reasons as string[]).includes("corrupt_record"));
    assert.match(String(result.guidance), /Narrow/u);
  } finally { await f.cleanup(); }
});

test("oversized records, response limits and scan limits stop with explicit incomplete results", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.select(id);
    const filename = path.join(f.directory, `${id}.jsonl`);
    await fs.appendFile(filename, `${"x".repeat(8 * 1024 * 1024 + 1)}\n`);
    await f.store.appendContext(id, Array.from({ length: 70 }, (_, index) => ({ role: "user", content: `limit needle ${index} ${"a".repeat(200)}` })));
    const runtime = f.runtime();
    await runtime.prepareStep();
    const result = await runtime.call("session_event_search", '{"query":"limit needle"}');
    const found = matches(result);
    assert.ok(found.length > 0 && found.length <= 50);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024);
    assert.equal(result.incomplete, true);
    assert.ok((result.incomplete_reasons as string[]).includes("record_limit"));
    assert.ok((result.incomplete_reasons as string[]).some((reason) => reason === "response_limit" || reason === "result_limit"));
    const chunk = `${"z".repeat(8 * 1024 * 1024 + 1)}\n`;
    for (let index = 0; index < 8; index += 1) await fs.appendFile(filename, chunk);
    await runtime.prepareStep();
    const scan = await runtime.call("session_event_search", '{"query":"absent"}');
    assert.equal(scan.incomplete, true);
    assert.ok((scan.incomplete_reasons as string[]).includes("scan_limit"));
  } finally { await f.cleanup(); }
});

test("already-aborted and mid-artifact cancellation propagate without a success result", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.select(id);
    const runtime = f.runtime();
    await runtime.prepareStep();
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(() => runtime.prepareStep(cancelled.signal), { name: "AbortError" });
    await assert.rejects(() => runtime.call("session_event_search", '{"query":"needle"}', cancelled.signal), { name: "AbortError" });
    await assert.rejects(() => runtime.readToolOutput('{"output_id":"missing"}', cancelled.signal), { name: "AbortError" });
    await f.store.appendContext(id, [{ type: "function_call", call_id: "cancel", name: "run_command", arguments: "{}" }]);
    const prepared = prepareToolOutput("needle".repeat(10_000), "run_command");
    await f.store.commitToolResult(id, { type: "function_call_output", call_id: "cancel", output: prepared.output }, prepared.attachment);
    await runtime.prepareStep();
    const abort = new AbortController();
    const read = f.store.readReferencedToolOutput.bind(f.store);
    f.store.readReferencedToolOutput = async (session, reference) => { const stored = await read(session, reference); abort.abort(); return stored; };
    await assert.rejects(() => runtime.call("session_event_search", '{"query":"needle"}', abort.signal), { name: "AbortError" });
  } finally { await f.cleanup(); }
});

test("event pagination remains stable when retained output is evicted, while output continuation becomes unavailable", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.select(id);
    await f.store.appendContext(id, [{ type: "function_call", call_id: "first", name: "run_command", arguments: "{}" }]);
    const prepared = prepareToolOutput(`eviction needle ${"x".repeat(40_000)}`, "run_command");
    await f.store.commitToolResult(id, { type: "function_call_output", call_id: "first", output: prepared.output }, prepared.attachment);
    const runtime = f.runtime();
    await runtime.prepareStep();
    const event = matches(await runtime.call("session_event_search", '{"query":"eviction needle"}'))[0]!;
    const args = JSON.stringify({ event_id: event.event_id, offset_bytes: 30, max_bytes: 80 });
    const before = await runtime.call("session_event_read", args);
    for (let index = 0; index < 16; index += 1) {
      const callId = `new-${index}`;
      await f.store.appendContext(id, [{ type: "function_call", call_id: callId, name: "run_command", arguments: "{}" }]);
      const later = prepareToolOutput("y".repeat(40_000), "run_command");
      await f.store.commitToolResult(id, { type: "function_call_output", call_id: callId, output: later.output }, later.attachment);
    }
    await runtime.prepareStep();
    const after = await runtime.call("session_event_read", args);
    assert.deepEqual(after, before);
    assert.equal((await runtime.readToolOutput(JSON.stringify({ output_id: prepared.attachment!.output_id }))).status, "not_found");
  } finally { await f.cleanup(); }
});

test("deleting a session during an attachment read cannot return historical success", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.select(id);
    await f.store.appendContext(id, [{ type: "function_call", call_id: "race", name: "run_command", arguments: "{}" }]);
    const prepared = prepareToolOutput("delete needle".repeat(4000), "run_command");
    await f.store.commitToolResult(id, { type: "function_call_output", call_id: "race", output: prepared.output }, prepared.attachment);
    const runtime = f.runtime();
    await runtime.prepareStep();
    const read = f.store.readReferencedToolOutput.bind(f.store);
    f.store.readReferencedToolOutput = async (session, reference) => {
      const stored = await read(session, reference);
      await f.store.deleteMany([id]);
      return stored;
    };
    assert.equal((await runtime.readToolOutput(JSON.stringify({ output_id: prepared.attachment!.output_id }))).status, "not_found");
  } finally { await f.cleanup(); }
});

test("explicit history targets do not follow symbolic links to session logs", async (t) => {
  const f = await fixture();
  try {
    const id = await f.create();
    await f.store.appendContext(id, [{ role: "user", content: "symlink needle" }]);
    const original = path.join(f.directory, `${id}.jsonl`);
    const outside = path.join(f.directory, "external-log");
    await fs.rename(original, outside);
    try { await fs.symlink(outside, original, "file"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("Filesystem does not permit file symlinks"); return; }
      throw error;
    }
    const runtime = f.runtime();
    assert.equal((await runtime.call("session_event_search", JSON.stringify({ query: "needle", session_id: id }))).status, "not_found");
    assert.equal(matches(await runtime.call("session_search", '{"query":"needle"}')).length, 0);
  } finally { await f.cleanup(); }
});

test("escape-heavy history pages fit inline output limits and reconstruct the complete text", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.select(id);
    const text = `Escaping needle\n${'\\"\u0001😀\r\n'.repeat(10_000)}`;
    await f.store.appendContext(id, [{ role: "user", content: text }]);
    const runtime = f.runtime();
    await runtime.prepareStep();
    const event = matches(await runtime.call("session_event_search", '{"query":"Escaping needle"}'))[0]!;
    let reconstructed = "";
    let offset = 0;
    for (let page = 0; page < 100; page += 1) {
      const read = await runtime.call("session_event_read", JSON.stringify({ event_id: event.event_id, offset_bytes: offset }));
      assert.equal(read.status, "ok");
      assert.ok(Buffer.byteLength(JSON.stringify(read)) <= 32 * 1024);
      reconstructed += String(read.content);
      if (read.complete) break;
      assert.ok(Number(read.next_offset_bytes) > offset);
      offset = Number(read.next_offset_bytes);
    }
    assert.equal(reconstructed, text);
  } finally { await f.cleanup(); }
});

test("a search that reaches its time deadline returns explicit incomplete guidance", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    await f.store.appendContext(id, [{ role: "user", content: "deadline needle" }]);
    const runtime = f.runtime();
    const originalNow = Date.now;
    let clockReads = 0;
    try {
      Date.now = () => ++clockReads <= 3 ? 1000 : 31_001;
      const result = await runtime.call("session_event_search", JSON.stringify({ session_id: id, query: "needle" }));
      assert.equal(matches(result).length, 0);
      assert.equal(result.incomplete, true);
      assert.ok((result.incomplete_reasons as string[]).includes("time_limit"));
      assert.match(String(result.guidance), /Narrow/u);
    } finally { Date.now = originalNow; }
  } finally { await f.cleanup(); }
});

test("recomputed reference bindings cannot disguise a reused Memory call_id as an older ordinary tool", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.select(id);
    await f.store.appendContext(id, [{ type: "function_call", call_id: "reused", name: "run_command", arguments: '{"command":"ordinary anchor"}' }]);
    await f.store.appendContext(id, [{ type: "function_call", call_id: "reused", name: "memory_lookup", arguments: "{}" }]);
    await f.store.appendContext(id, [{ role: "user", content: "visible anchor" }, { type: "function_call_output", call_id: "reused", output: "EXCLUDED MEMORY SECRET" }]);
    const runtime = f.runtime();
    await runtime.prepareStep();
    assert.equal(matches(await runtime.call("session_event_search", '{"query":"EXCLUDED MEMORY"}')).length, 0);
    const ordinary = matches(await runtime.call("session_event_search", '{"query":"ordinary anchor"}'))[0]!;
    const visible = matches(await runtime.call("session_event_search", '{"query":"visible anchor"}'))[0]!;
    const oldCall = JSON.parse(Buffer.from(String(ordinary.event_id).slice(8), "base64url").toString("utf8"));
    const valid = JSON.parse(Buffer.from(String(visible.event_id).slice(8), "base64url").toString("utf8"));
    const payload = { session: valid.session, header: valid.header, offset: valid.offset, item: 1, digest: valid.digest, call: { offset: oldCall.offset, item: oldCall.item, digest: oldCall.digest } };
    const forged = { ...payload, binding: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
    const eventId = `history_${Buffer.from(JSON.stringify(forged)).toString("base64url")}`;
    const read = await runtime.call("session_event_read", JSON.stringify({ event_id: eventId }));
    assert.equal(read.status, "not_found");
    assert.ok(!JSON.stringify(read).includes("EXCLUDED MEMORY SECRET"));
    assert.equal((await runtime.call("session_event_read", JSON.stringify({ event_id: visible.event_id }))).content, "visible anchor");
  } finally { await f.cleanup(); }
});

test("output references remain append-stable and fail closed when intervening origin evidence is corrupt or oversized", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.select(id);
    await f.store.appendContext(id, [{ type: "function_call", call_id: "stable-tool", name: "run_command", arguments: "{}" }]);
    const filename = path.join(f.directory, `${id}.jsonl`);
    await f.store.appendContext(id, [{ role: "user", content: "intervening anchor" }]);
    await f.store.appendContext(id, [{ type: "function_call_output", call_id: "stable-tool", output: "Stable tool output" }]);
    const runtime = f.runtime();
    await runtime.prepareStep();
    const event = matches(await runtime.call("session_event_search", '{"query":"Stable tool output"}'))[0]!;
    await f.store.appendContext(id, [{ type: "function_call", call_id: "stable-tool", name: "memory_lookup", arguments: "{}" }]);
    await runtime.prepareStep();
    assert.equal((await runtime.call("session_event_read", JSON.stringify({ event_id: event.event_id }))).content, "Stable tool output");
    const records = (await fs.readFile(filename, "utf8")).split("\n");
    const index = records.findIndex((line) => line.includes("intervening anchor"));
    // Keep byte lengths and the target record's position/digest unchanged.
    records[index] = "!".repeat(Buffer.byteLength(records[index]!));
    await fs.writeFile(filename, records.join("\n"));
    const corrupt = await runtime.call("session_event_read", JSON.stringify({ event_id: event.event_id }));
    assert.equal(corrupt.status, "not_found");
    assert.equal(corrupt.incomplete, true);
    assert.ok((corrupt.incomplete_reasons as string[]).includes("corrupt_record"));
    // A reference minted from an otherwise readable log must still reject an oversized gap.
    const gapId = await f.create();
    await f.store.appendContext(gapId, [{ type: "function_call", call_id: "large-gap", name: "run_command", arguments: "{}" }]);
    await fs.appendFile(path.join(f.directory, `${gapId}.jsonl`), `${"z".repeat(8 * 1024 * 1024 + 1)}\n`);
    await f.store.appendContext(gapId, [{ type: "function_call_output", call_id: "large-gap", output: "Oversized-gap tool output" }]);
    assert.equal(matches(await runtime.call("session_event_search", JSON.stringify({ session_id: gapId, query: "Oversized-gap tool output" }))).length, 0);
    const gapLog = await fs.readFile(path.join(f.directory, `${gapId}.jsonl`));
    const gapLines = gapLog.toString("utf8").trimEnd().split("\n");
    const resultOffset = Buffer.byteLength(gapLines.slice(0, 3).join("\n")) + 1;
    const gapPayload = {
      session: gapId, header: createHash("sha256").update(gapLines[0]!).digest("hex"),
      offset: resultOffset, item: 0, digest: createHash("sha256").update(gapLines[3]!).digest("hex"),
      call: { offset: Buffer.byteLength(gapLines[0]!) + 1, item: 0, digest: createHash("sha256").update(gapLines[1]!).digest("hex") },
    };
    const gapReference = { ...gapPayload, binding: createHash("sha256").update(JSON.stringify(gapPayload)).digest("hex") };
    const oversized = await runtime.call("session_event_read", JSON.stringify({ session_id: gapId, event_id: `history_${Buffer.from(JSON.stringify(gapReference)).toString("base64url")}` }));
    assert.equal(oversized.status, "not_found");
    assert.equal(oversized.incomplete, true);
    assert.ok((oversized.incomplete_reasons as string[]).includes("record_limit"));
  } finally { await f.cleanup(); }
});

test("search refuses to pair tool results across corrupt records or previously consumed call_ids", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.select(id);
    await f.store.appendContext(id, [{ type: "function_call", call_id: "broken", name: "run_command", arguments: "{}" }]);
    await fs.appendFile(path.join(f.directory, `${id}.jsonl`), "{bad-middle}\n");
    await f.store.appendContext(id, [{ type: "function_call_output", call_id: "broken", output: "Excluded uncertain output" }]);
    await f.store.appendContext(id, [{ type: "function_call", call_id: "consumed", name: "run_command", arguments: "{}" }]);
    await f.store.appendContext(id, [{ type: "function_call_output", call_id: "consumed", output: "First consumed output" }]);
    await f.store.appendContext(id, [{ role: "user", content: "visible result anchor" }, { type: "function_call_output", call_id: "consumed", output: "Excluded repeated output" }]);
    const runtime = f.runtime();
    await runtime.prepareStep();
    const search = await runtime.call("session_event_search", '{"query":"Excluded"}');
    assert.equal(matches(search).length, 0);
    assert.equal(search.incomplete, true);
    const ordinary = matches(await runtime.call("session_event_search", '{"query":"First consumed output"}'))[0]!;
    const visible = matches(await runtime.call("session_event_search", '{"query":"visible result anchor"}'))[0]!;
    const oldCall = JSON.parse(Buffer.from(String(ordinary.event_id).slice(8), "base64url").toString("utf8")).call;
    const anchor = JSON.parse(Buffer.from(String(visible.event_id).slice(8), "base64url").toString("utf8"));
    const payload = { session: anchor.session, header: anchor.header, offset: anchor.offset, item: 1, digest: anchor.digest, call: { offset: oldCall.offset, item: oldCall.item, digest: oldCall.digest } };
    const forged = { ...payload, binding: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
    assert.equal((await runtime.call("session_event_read", JSON.stringify({ event_id: `history_${Buffer.from(JSON.stringify(forged)).toString("base64url")}` }))).status, "not_found");
  } finally { await f.cleanup(); }
});

test("a delayed target-record read cannot return a page after its deadline", async (t) => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.select(id);
    await f.store.appendContext(id, [{ role: "user", content: "Delayed target needle" }]);
    const runtime = f.runtime();
    await runtime.prepareStep();
    const event = matches(await runtime.call("session_event_search", '{"query":"Delayed target needle"}'))[0]!;
    const reference = JSON.parse(Buffer.from(String(event.event_id).slice(8), "base64url").toString("utf8"));
    const originalOpen = fs.open;
    let now = 1000;
    const originalNow = Date.now;
    const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === path.join(f.directory, `${id}.jsonl`)) {
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs: unknown[]) => {
          const value = await (read as (...args: unknown[]) => Promise<unknown>)(...readArgs);
          if (readArgs[3] === reference.offset) now = 31_001;
          return value;
        }) as typeof handle.read;
      }
      return handle;
    });
    try {
      Date.now = () => now;
      const result = await runtime.call("session_event_read", JSON.stringify({ event_id: event.event_id }));
      assert.equal(result.status, "not_found");
      assert.equal(result.incomplete, true);
      assert.ok((result.incomplete_reasons as string[]).includes("time_limit"));
      assert.match(String(result.guidance), /origin|limits/u);
    } finally { Date.now = originalNow; mocked.mock.restore(); }
  } finally { await f.cleanup(); }
});

test("valid legacy events without a final newline remain readable and keep references after append", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    await f.store.appendContext(id, [{ role: "user", content: "Legacy valid-tail needle" }]);
    const filename = path.join(f.directory, `${id}.jsonl`);
    const bytes = await fs.readFile(filename);
    await fs.truncate(filename, bytes.length - 1);
    const runtime = f.runtime();
    const search = await runtime.call("session_event_search", JSON.stringify({ session_id: id, query: "valid-tail needle" }));
    assert.equal(search.incomplete, false);
    const event = matches(search)[0]!;
    assert.equal((await runtime.call("session_event_read", JSON.stringify({ session_id: id, event_id: event.event_id }))).content, "Legacy valid-tail needle");
    await f.store.appendContext(id, [{ role: "assistant", content: "Later appended needle" }]);
    assert.equal((await runtime.call("session_event_read", JSON.stringify({ session_id: id, event_id: event.event_id }))).content, "Legacy valid-tail needle");
    const restarted = new SessionHistoryRuntime({ store: new SessionStore({ directory: f.directory }), workspacePath: "C:\\repo", sessionId: () => undefined });
    assert.equal((await restarted.call("session_event_read", JSON.stringify({ session_id: id, event_id: event.event_id }))).content, "Legacy valid-tail needle");
    const found = matches(await restarted.call("session_event_search", JSON.stringify({ session_id: id, query: "needle" })));
    assert.equal(found.length, 2);
    assert.equal(found[0]!.event_id, event.event_id);
    assert.equal((await f.store.load(id)).context.length, 2);
  } finally { await f.cleanup(); }
});

test("partial and schema-invalid legacy tails are ignored and do not invalidate earlier references after repair", async () => {
  const f = await fixture();
  try {
    for (const tail of ['{"version":1', JSON.stringify({ version: 1, type: "context_append", at: new Date().toISOString(), items: [null] })]) {
      const id = await f.create();
      await f.store.appendContext(id, [{ role: "user", content: "Prior tail needle" }]);
      await fs.appendFile(path.join(f.directory, `${id}.jsonl`), tail);
      const runtime = f.runtime();
      const result = await runtime.call("session_event_search", JSON.stringify({ session_id: id, query: "needle" }));
      assert.equal(result.incomplete, false);
      const event = matches(result)[0]!;
      await f.store.appendContext(id, [{ role: "assistant", content: "Repaired tail needle" }]);
      assert.equal((await runtime.call("session_event_read", JSON.stringify({ session_id: id, event_id: event.event_id }))).content, "Prior tail needle");
      const after = await runtime.call("session_event_search", JSON.stringify({ session_id: id, query: "needle" }));
      assert.equal(after.incomplete, false);
      assert.equal(matches(after).length, 2);
    }
  } finally { await f.cleanup(); }
});
