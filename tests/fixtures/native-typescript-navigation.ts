/** Native semantic acceptance using an explicitly installed, pinned TS LSP. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodeNavigationRuntime, type CodeNavigationRequest } from "../../src/tools/code-navigation.js";
import { createLspSandboxPolicy } from "../../src/tools/sandbox-policy.js";

const server = process.argv[2];
if (!server || !path.isAbsolute(server)) throw new Error("Pass an absolute pinned typescript-language-server lib/cli.mjs path");
const root = await mkdtemp(path.join(os.tmpdir(), "everpeace-native-ts-navigation-"));
const source = [
  "export interface Greeter { greet(): string; }",
  "export class Friendly implements Greeter { greet() { return 'hello'; } }",
  "const speaker: Greeter = new Friendly();",
  "export const message = speaker.greet();",
].join("\n") + "\n";
const runtime = new CodeNavigationRuntime({
  workspacePath: root, command: process.execPath, args: [server, "--stdio"],
  policy: createLspSandboxPolicy(root, [path.dirname(process.execPath), path.resolve(path.dirname(server), "../..")]),
});
try {
  await writeFile(path.join(root, "sample.ts"), source);
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["sample.ts"] }));
  const requests: CodeNavigationRequest[] = [
    { operation: "definition", path: "sample.ts", line: 3, column: 30 },
    { operation: "references", path: "sample.ts", line: 2, column: 14 },
    { operation: "implementation", path: "sample.ts", line: 1, column: 18 },
    { operation: "hover", path: "sample.ts", line: 4, column: 25 },
  ];
  const results = [];
  for (const request of requests) {
    const result = await runtime.query(request);
    if (request.operation === "hover") assert.match(result.hover ?? "", /Greeter|speaker/u);
    else assert.ok(result.locations?.some((location) => location.path === "sample.ts"), `${request.operation} must resolve a real source location`);
    results.push(result);
  }
  process.stdout.write(JSON.stringify({ passed: true, isolation: runtime.getIsolationEvidence(), results }) + "\n");
} finally {
  // Every query waits for LSP process cleanup before returning.
  await rm(root, { recursive: true, force: true });
}
