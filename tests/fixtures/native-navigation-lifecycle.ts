import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CodeNavigationRuntime } from "../../src/tools/code-navigation.js";
import { createLspSandboxPolicy } from "../../src/tools/sandbox-policy.js";

if (process.platform !== "win32") throw new Error("Windows native acceptance only");
const run = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), "everpeace-native-navigation-lifecycle-"));
const source = path.join(root, "sample.ts");
const server = path.join(root, "offline-lsp.mjs");
await writeFile(source, "export const fixture = 1;\n");
await writeFile(server, await readFile(new URL("offline-lsp.mjs", import.meta.url)));
const receipts: unknown[] = [];
async function ownedPids(): Promise<number[]> {
  const escaped = server.replaceAll("'", "''");
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-Command", `$ids = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine.Contains('${escaped}') } | Select-Object -ExpandProperty ProcessId); ConvertTo-Json -InputObject $ids -Compress`], { windowsHide: true, timeout: 10000 });
  return JSON.parse(stdout) as number[];
}
try {
  for (const kind of ["cancel", "permission-change"] as const) {
    let revision = "initial";
    const runtime = new CodeNavigationRuntime({ workspacePath: root, command: process.execPath, args: [server, "60000"], policy: createLspSandboxPolicy(root, [path.dirname(process.execPath)]), permissionRevision: () => revision });
    const controller = new AbortController();
    const result = runtime.query({ operation: "hover", path: "sample.ts", line: 1, column: 14 }, controller.signal);
    // Observe the real configured child, not an elapsed startup delay or the probe.
    const deadline = Date.now() + 20000;
    let pids: number[] = [];
    while (pids.length < 2 && Date.now() < deadline) pids = await ownedPids();
    assert.ok(pids.length >= 2, "Native launcher and configured Node child must really start");
    if (kind === "cancel") controller.abort(new Error("Controlled native cancellation"));
    else revision = "tightened";
    await assert.rejects(result);
    assert.deepEqual(await ownedPids(), [], "No owned native child may remain after query rejection");
    for (const pid of pids) assert.throws(() => process.kill(pid, 0));
    receipts.push({ kind, observedPids: pids, exited: true, isolation: runtime.getIsolationEvidence() });
  }
  process.stdout.write(JSON.stringify({ passed: true, receipts }) + "\n");
} finally {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  await rm(root, { recursive: true, force: true });
}
