import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { writeSupplyChain } from "../../fixtures/supply-chain.js";

const policy = await import(new URL("../../../scripts/security/policy.mjs", import.meta.url).href);
const publishing = await import(new URL("../../../scripts/release/publish.mjs", import.meta.url).href);
const { digest } = await import(new URL("../../../scripts/release/policy.mjs", import.meta.url).href);

test("audit and SPDX policies reject severe findings, outages, incomplete reports and unreviewed licenses", () => {
  const clean = { metadata: { totalDependencies: 1, vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 0 } } };
  policy.checkAudit(clean);
  for (const report of [{}, { error: "unavailable" }, { metadata: { vulnerabilities: {} } }, ...["high", "critical"].map((level) => ({ metadata: { ...clean.metadata, vulnerabilities: { ...clean.metadata.vulnerabilities, [level]: 1 } } }))]) assert.throws(() => policy.checkAudit(report));
  for (const license of ["MIT", "MIT AND Apache-2.0", "GPL-3.0-only OR MIT"]) assert.equal(policy.allowedLicense(license), true);
  for (const license of ["UNKNOWN", "MIT AND GPL-3.0-only", "GPL-3.0-only", "MIT WITH LLVM-exception"]) assert.equal(policy.allowedLicense(license), false);
  assert.throws(() => policy.checkLicenses({ UNKNOWN: [{ name: "fixture", versions: ["1.0.0"] }] }));
  assert.throws(() => policy.installedLicenses({ components: [{ name: "fixture", version: "1.0.0", purl: "pkg:npm/fixture@1.0.0" }] }));
  assert.throws(() => policy.checkLicenses({ "GPL-3.0-only": [{ name: "fixture", versions: ["2.0.0"] }] }, [{ name: "fixture", version: "1.0.0", license: "GPL-3.0-only", reason: "fixture", review: "fixture" }]));
});

test("missing reports, SBOM omissions, wrong identities, secrets and tampered evidence prevent all publication mutations", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-security-failure-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sha = "a".repeat(40), filename = "everpeace-1.2.3.tgz";
  await fs.writeFile(path.join(directory, filename), "fixture");
  const packageDigest = digest(path.join(directory, filename));
  await fs.writeFile(path.join(directory, "receipt.json"), JSON.stringify({ schema: 1, commit: sha, dirty: false, version: "1.2.3", filename, sha256: packageDigest }));
  const checks = Object.fromEntries(["candidate", "package", "consumers", "security", "evidence", "native", "gate"].map((key) => [key, "success"]));
  let requests = 0;
  const args = { directory, sha, packageDigest, checks, repo: "fixture/repository", api: async () => { requests++; throw new Error("No GitHub request allowed"); } };
  for (const fault of ["missing", "digest", "sbom", "secret", "audit", "identity", "license", "consumer", "native", "installed_license"]) {
    await writeSupplyChain(directory, sha, packageDigest);
    const manifestPath = path.join(directory, "supply-chain.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    let file: string | undefined;
    if (fault === "missing") await fs.rm(path.join(directory, "audit.json"));
    if (fault === "digest") await fs.writeFile(path.join(directory, "audit.json"), "tampered");
    if (fault === "sbom") { file = "lock.cdx.json"; await fs.writeFile(path.join(directory, file), JSON.stringify({ bomFormat: "CycloneDX", components: [{ name: "fixture", version: "1.0.0" }] })); }
    if (["secret", "identity"].includes(fault)) { file = "scan.json"; const scan = JSON.parse(await fs.readFile(path.join(directory, file), "utf8")); if (fault === "secret") scan.unreviewedSecrets = 1; else scan.commit = "b".repeat(40); await fs.writeFile(path.join(directory, file), JSON.stringify(scan)); }
    if (fault === "audit") { file = "audit.json"; await fs.writeFile(path.join(directory, file), '{"error":"scanner unavailable"}'); }
    if (fault === "license") { file = "licenses.json"; await fs.writeFile(path.join(directory, file), '{"schema":1,"components":[{"name":"fixture","version":"1.0.0","license":"UNKNOWN"}]}'); }
    if (fault === "consumer") { file = "consumer-win32-x64.json"; const receipt = JSON.parse(await fs.readFile(path.join(directory, file), "utf8")); receipt.local = true; await fs.writeFile(path.join(directory, file), JSON.stringify(receipt)); }
    if (fault === "native") { file = "consumer-win32-npm-native.json"; await fs.writeFile(path.join(directory, file), '{"schema":1,"files":[]}'); }
    if (fault === "installed_license") { file = "consumer-win32-npm-licenses.json"; await fs.writeFile(path.join(directory, file), '{"schema":1,"components":[]}'); }
    if (file) { manifest.files[file] = digest(path.join(directory, file)); await fs.writeFile(manifestPath, JSON.stringify(manifest)); }
    await assert.rejects(publishing.publish(args)); assert.equal(requests, 0, fault);
  }
  for (const status of ["failure", "skipped", "cancelled", undefined]) await assert.rejects(publishing.publish({ ...args, checks: { ...checks, security: status } }));
  assert.equal(requests, 0);
});
