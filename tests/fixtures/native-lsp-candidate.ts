/** Development-only probe for a fixed native launcher; never invokes a provider. */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodeNavigationRuntime } from "../../src/tools/code-navigation.js";
import { startCodexDuplexProcess } from "../../src/codex/cli.js";
import { createLspSandboxPolicy, modelShellEnvironment, nativeLspPermissionProfileArgs } from "../../src/tools/sandbox-policy.js";
import { redactSecretsPreservingLayout } from "../../src/util/redact-secrets.js";

const launcher = process.argv[2];
if (!launcher || !path.isAbsolute(launcher)) throw new Error("Pass an absolute fixed Codex launcher path");
const root = await mkdtemp(path.join(os.tmpdir(), "everpeace-lsp-candidate-"));
const overrides = process.argv.slice(3);
let launcherFailure: string | undefined;
const runtime = new CodeNavigationRuntime({
  workspacePath: root,
  command: process.execPath,
  policy: createLspSandboxPolicy(root, [path.dirname(process.execPath)]),
  startProcess(options) {
    const child = startCodexDuplexProcess([
      "sandbox", ...nativeLspPermissionProfileArgs(options.policy), "-C", options.cwd,
      ...options.policy.readableRoots.flatMap((readRoot) => ["--sandbox-state-readable-root", readRoot]),
      "--sandbox-state-disable-network", "--include-managed-config",
      "-c", "shell_environment_policy.ignore_default_excludes=false",
      ...overrides.flatMap((override) => ["-c", override]),
      "--", options.command, ...options.args,
    ], { cwd: options.cwd, env: modelShellEnvironment(process.env), codexCliPath: launcher, timeoutMs: 10_000 });
    void child.exit.then((result) => {
      if (result.exitCode !== 0) launcherFailure = redactSecretsPreservingLayout(result.stderr).slice(-4096);
    }, () => {});
    return child;
  },
});
try {
  await runtime.probeIsolation();
  process.stdout.write(JSON.stringify({ passed: true, evidence: runtime.getIsolationEvidence() }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ passed: false, evidence: runtime.getIsolationEvidence(), launcherFailure, error: error instanceof Error ? error.message : String(error) }) + "\n");
  process.exitCode = 1;
} finally {
  // The probe joins native termination before the owned temporary root is removed.
  await rm(root, { recursive: true, force: true });
}
