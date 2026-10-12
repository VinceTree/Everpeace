import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import { EXEC_OUTPUT_BUFFER_BYTES, EXEC_OUTPUT_CHUNK_BYTES, ExecStreamWriter } from "../../../src/cli/exec-writer.js";

test("a slow consumer bounds buffered bytes and holds the producer until callbacks and drain", async () => {
  let maximum = 0;
  let consumed = 0;
  const stream = new Writable({
    highWaterMark: 1024,
    write(chunk: Buffer, _encoding, done) {
      maximum = Math.max(maximum, stream.writableLength);
      consumed += chunk.length;
      setTimeout(done, 1);
    },
  });
  const writer = new ExecStreamWriter(stream);
  const text = "😀".repeat(400_000);
  await writer.write(text);
  assert.equal(consumed, Buffer.byteLength(text));
  assert.ok(maximum <= EXEC_OUTPUT_CHUNK_BYTES);
  assert.ok(maximum < EXEC_OUTPUT_BUFFER_BYTES);
  assert.equal(stream.writableLength, 0);
  stream.destroy();
});

test("a stalled writable times out without writing a second chunk", async () => {
  let writes = 0;
  const stream = new Writable({ write() { writes += 1; } });
  const writer = new ExecStreamWriter(stream, { stallMs: 30 });
  await assert.rejects(writer.write("x".repeat(100_000)), /no progress/);
  assert.equal(writes, 1);
  await assert.rejects(writer.write("late"), /no progress/);
  stream.destroy();
});

test("close, errors and cancellation interrupt drain waits", async (t) => {
  for (const mode of ["close", "error", "cancel"] as const) {
    await t.test(mode, async () => {
      let started!: () => void;
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const stream = new Writable({ write() { started(); } });
      stream.on("error", () => {});
      const controller = new AbortController();
      const writer = new ExecStreamWriter(stream);
      const writing = writer.write("x".repeat(100_000), controller.signal);
      await entered;
      if (mode === "cancel") controller.abort(new Error("cancelled fixture"));
      else stream.destroy(mode === "error" ? new Error("broken fixture") : undefined);
      await assert.rejects(writing, /closed|failed|cancelled/);
      stream.destroy();
    });
  }
});
