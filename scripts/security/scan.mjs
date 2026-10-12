import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { packageManager, runCommand } from "../release/commands.mjs";
import { checkAudit, checkLicenses } from "./policy.mjs";
import { withSecurityTool, sbom } from "./tools.mjs";
import { captureAudit } from "./audit.mjs";
import { createHash } from "node:crypto";

const output = path.resolve(process.argv[2]);
await fs.mkdir(output, { recursive: true });
const staging = await fs.mkdtemp(path.join(tmpdir(), "everpeace-security-source-"));
try {
  // Copy only maintained Git files; do not scan users' untracked fixtures or private logs.
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src", "tests", "scripts", ".github", ".gitleaks.toml", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"], { encoding: "utf8" }).split("\0").filter(Boolean);
  for (const file of files) {
    const destination = path.join(staging, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(file, destination);
  }
  await withSecurityTool("gitleaks", async (executable) => {
    // Suppress all scanner stdout/stderr; only fully redacted JSON is retained.
    for (const [mode, source, report] of [["git", ".", "secrets-history.json"], ["dir", staging, "secrets-current.json"]]) {
      await runCommand(executable, [mode, source, "--redact=100", "--exit-code=0", "--no-banner", "--config", path.resolve(".gitleaks.toml"), "--report-format", "json", "--report-path", path.join(output, report), ...(mode === "git" ? ["--log-opts=--all"] : [])], { stdio: "ignore" });
      const findings = JSON.parse(await fs.readFile(path.join(output, report), "utf8"));
      assert.ok(Array.isArray(findings), "Secret report missing");
      const exceptions = JSON.parse(await fs.readFile(new URL("./public-test-keys.json", import.meta.url), "utf8"));
      for (const finding of findings) {
        const file = mode === "git" ? finding.File : path.relative(staging, path.resolve(finding.File)).replaceAll("\\", "/");
        const bytes = mode === "git" ? execFileSync("git", ["show", `${finding.Commit}:${file}`], { maxBuffer: 2 * 1024 * 1024 }) : await fs.readFile(path.join(staging, file));
        const hash = createHash("sha256").update(bytes).digest("hex");
        assert.ok(exceptions.some((entry) => entry.rule === finding.RuleID && entry.file === file && entry.sha256.includes(hash) && entry.reason && entry.review), "Secret scan found an unreviewed secret; inspect the redacted report");
      }
    }
  });
  // pnpm audit exits nonzero for low findings too. Preserve its JSON, then apply severity policy.
  const audit = await captureAudit();
  const report = JSON.parse(audit);
  await fs.writeFile(path.join(output, "audit.json"), JSON.stringify(report, null, 2) + "\n");
  checkAudit(report);
  const licenses = checkLicenses(JSON.parse(await packageManager("pnpm", ["licenses", "list", "--json"])), JSON.parse(await fs.readFile(new URL("./license-exceptions.json", import.meta.url), "utf8")));
  await fs.writeFile(path.join(output, "licenses.json"), JSON.stringify(licenses, null, 2) + "\n");
  // Only package metadata/lock are catalogued here; bundled and installed bytes have separate SBOMs.
  const lock = path.join(staging, "lock");
  await fs.mkdir(lock);
  for (const file of ["package.json", "pnpm-lock.yaml"]) await fs.copyFile(file, path.join(lock, file));
  await sbom(lock, path.join(output, "lock.cdx.json"), ["@openai/codex", "@modelcontextprotocol/sdk", "node-pty", "node-addon-api"]);
  const { digest } = await import("../release/policy.mjs");
  await fs.writeFile(path.join(output, "scan.json"), JSON.stringify({ schema: 1, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), lockSha256: digest("pnpm-lock.yaml"), success: true, unreviewedSecrets: 0, coverage: "full Git history and maintained working files; full lockfile including development dependencies", limitations: "Compiled native internal dependencies cannot all be identified; patch and native binary digests are recorded by package provenance." }, null, 2));
  console.log("Security audit, secret, license and lock SBOM checks passed.");
} finally {
  assert.equal(path.dirname(staging), tmpdir());
  assert.ok(path.basename(staging).startsWith("everpeace-security-source-"));
  await fs.rm(staging, { recursive: true, force: true });
}
