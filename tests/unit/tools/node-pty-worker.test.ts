import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";
import { test } from "node:test";

const require = createRequire(import.meta.url);

async function proxy(destination: Writable): Promise<PassThrough> {
  const sockets: PassThrough[] = [];
  const source = await readFile(path.join(path.dirname(require.resolve("node-pty/package.json")), "lib/worker/conoutSocketWorker.js"), "utf8");
  class Socket extends PassThrough {
    constructor() { super(); sockets.push(this); }
    connect(_name: string, connected: () => void): this { connected(); return this; }
  }
  vm.runInNewContext(source, {
    exports: {},
    require(name: string) {
      if (name === "worker_threads") return { workerData: { conoutPipeName: "fixture" }, parentPort: { postMessage() {} } };
      if (name === "net") return { Socket, createServer: (connected: (socket: Writable) => void) => ({ listen() { connected(destination); } }) };
      if (name === "../shared/conout") return { getWorkerPipeName: () => "fixture-proxy" };
      throw new Error(`Unexpected worker dependency: ${name}`);
    },
  });
  assert.equal(sockets.length, 1);
  return sockets[0]!;
}

test("installed Conpty worker drains trailing output after a closed proxy write", async () => {
  for (const code of ["EPIPE", "ECONNRESET"]) {
    let writes = 0;
    const destination = new Writable({ write(_chunk, _encoding, callback) { writes += 1; callback(Object.assign(new Error("closed fixture peer"), { code })); } });
    const conout = await proxy(destination);
    try {
      conout.write("last output");
      await setImmediate();
      conout.write("late Conpty flush");
      await setImmediate();
      assert.equal(writes, 1, "No write may reach the closed proxy after its error");
      assert.equal(destination.destroyed, true);
      assert.equal(conout.readableFlowing, true, "Conpty must keep draining until its owner closes it");
      assert.equal(conout.readableLength, 0);
    } finally { conout.destroy(); destination.destroy(); }
  }
});

test("installed Conpty worker detaches on peer shutdown and preserves unexpected errors", async () => {
  for (const event of ["end", "close"]) {
    let writes = 0;
    const destination = new Writable({ write(_chunk, _encoding, callback) { writes += 1; callback(); } });
    const conout = await proxy(destination);
    try {
      destination.emit(event);
      conout.write("late output");
      await setImmediate();
      assert.equal(writes, 0);
      assert.equal(conout.readableLength, 0);
      const error = Object.assign(new Error("unexpected failure"), { code: "EACCES" });
      assert.throws(() => destination.emit("error", error), (caught: unknown) => caught === error);
    } finally { conout.destroy(); destination.destroy(); }
  }
});
