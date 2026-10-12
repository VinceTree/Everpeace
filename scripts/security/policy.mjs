import assert from "node:assert/strict";
import parse from "spdx-expression-parse";
import { digest } from "../release/policy.mjs";
import path from "node:path";
import { readFileSync } from "node:fs";

const allowed = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "CC0-1.0"]);
export function allowedLicense(expression) {
  try {
    function evaluate(node) {
      if (node.conjunction === "and") return evaluate(node.left) && evaluate(node.right);
      if (node.conjunction === "or") return evaluate(node.left) || evaluate(node.right);
      return allowed.has(node.license) && !node.exception && !node.plus;
    }
    return evaluate(parse(expression));
  } catch { return false; }
}

export function checkLicenses(groups, exceptions = []) {
  assert.ok(groups && typeof groups === "object" && Object.keys(groups).length, "License report missing");
  const components = [];
  for (const [license, packages] of Object.entries(groups)) {
    assert.ok(Array.isArray(packages) && packages.length, "Invalid license report");
    for (const item of packages) {
      const versions = item.versions ?? [item.version];
      assert.ok(typeof item.name === "string" && Array.isArray(versions) && versions.length && versions.every((version) => typeof version === "string"), "Component identity missing");
      for (const version of versions) {
        const exception = exceptions.find((entry) => entry.name === item.name && entry.version === version && entry.license === license && entry.reason && entry.review);
        assert.ok(allowedLicense(license) || exception, `License review required: ${item.name}@${version} (${license})`);
        components.push({ name: item.name, version, license, ...(exception ? { exception } : {}) });
      }
    }
  }
  return { schema: 1, components };
}

export function checkAudit(report) {
  const total = report?.metadata?.totalDependencies ?? report?.metadata?.dependencies?.total;
  assert.ok(report?.metadata?.vulnerabilities && Number.isSafeInteger(total) && total >= 0, "Audit report missing or service failed");
  for (const severity of ["info", "low", "moderate", "high", "critical"]) assert.ok(Number.isSafeInteger(report.metadata.vulnerabilities[severity]) && report.metadata.vulnerabilities[severity] >= 0, "Audit severity missing or invalid");
  assert.equal(report.metadata.vulnerabilities.high + report.metadata.vulnerabilities.critical, 0, "High/Critical dependency vulnerabilities require remediation");
}

export function checkSbom(report, required = []) {
  assert.equal(report?.bomFormat, "CycloneDX", "SBOM missing or invalid");
  assert.ok(Array.isArray(report.components) && report.components.length, "Empty SBOM");
  for (const name of required) assert.ok(report.components.some((entry) => (entry.group ? `${entry.group}/${entry.name}` : entry.name) === name && typeof entry.version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(entry.version)), `Missing resolved SBOM component: ${name}`);
}
export function installedLicenses(report, exceptions = []) {
  const groups = {};
  for (const component of report.components ?? []) {
    if (!component.purl?.startsWith("pkg:npm/") || !component.version) continue;
    const name = component.group ? `${component.group}/${component.name}` : component.name;
    const expressions = (component.licenses ?? []).map((entry) => entry.expression ?? entry.license?.id ?? entry.license?.name).filter(Boolean);
    const license = expressions.length ? expressions.map((expression) => `(${expression})`).join(" AND ") : "UNKNOWN";
    // Preserve the exact expression for a reviewed single-license exception.
    const normalized = expressions.length === 1 ? expressions[0] : license;
    (groups[normalized] ??= []).push({ name, version: component.version });
  }
  return checkLicenses(groups, exceptions);
}

export function verifySupplyChain(directory, sha, packageDigest) {
  const manifest = JSON.parse(readFileSync(path.join(directory, "supply-chain.json"), "utf8"));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.commit, sha);
  assert.equal(manifest.packageSha256, packageDigest);
  for (const required of ["scan.json", "secrets-history.json", "secrets-current.json", "audit.json", "licenses.json", "lock.cdx.json", "package.cdx.json", "consumer-linux-x64.json", "consumer-win32-x64.json"]) assert.ok(manifest.files[required], `Missing supply-chain evidence: ${required}`);
  for (const [file, hash] of Object.entries(manifest.files)) {
    assert.match(file, /^[a-z0-9._-]+$/u);
    assert.match(hash, /^[a-f0-9]{64}$/u);
    assert.equal(digest(path.join(directory, file)), hash, `Supply-chain digest mismatch: ${file}`);
  }
  checkAudit(JSON.parse(readFileSync(path.join(directory, "audit.json"), "utf8")));
  const scan = JSON.parse(readFileSync(path.join(directory, "scan.json"), "utf8"));
  assert.equal(scan.success, true); assert.equal(scan.commit, sha); assert.equal(scan.unreviewedSecrets, 0);
  assert.match(scan.lockSha256, /^[a-f0-9]{64}$/u, "Missing lockfile identity");
  assert.equal(scan.lockSha256, JSON.parse(readFileSync(path.join(directory, "receipt.json"), "utf8")).lockSha256);
  const licenseReport = JSON.parse(readFileSync(path.join(directory, "licenses.json"), "utf8"));
  assert.equal(licenseReport.schema, 1); assert.ok(Array.isArray(licenseReport.components) && licenseReport.components.length);
  const groups = {};
  for (const component of licenseReport.components) (groups[component.license] ??= []).push(component);
  checkLicenses(groups, JSON.parse(readFileSync(new URL("./license-exceptions.json", import.meta.url), "utf8")));
  const critical = ["@openai/codex", "@modelcontextprotocol/sdk", "node-pty", "node-addon-api"];
  checkSbom(JSON.parse(readFileSync(path.join(directory, "lock.cdx.json"), "utf8")), critical);
  checkSbom(JSON.parse(readFileSync(path.join(directory, "package.cdx.json"), "utf8")), ["node-pty", "node-addon-api"]);
  for (const platform of ["linux", "win32"]) {
    const receipt = JSON.parse(readFileSync(path.join(directory, `consumer-${platform}-x64.json`), "utf8"));
    assert.equal(receipt.commit, sha); assert.equal(receipt.packageSha256, packageDigest);
    assert.equal(receipt.success, true); assert.equal(receipt.local, false);
    assert.ok(Array.isArray(receipt.checks) && receipt.checks.length === 3);
    for (const mode of ["npm", "pnpm", "global"]) {
      const file = `consumer-${platform}-${mode}.cdx.json`;
      assert.ok(manifest.files[file], `Missing consumer SBOM: ${file}`);
      assert.ok(receipt.checks.some((check) => check.mode === mode && check.success && check.sbom === file && check.sha256 === manifest.files[file]), "Consumer dependency snapshot receipt mismatch");
      checkSbom(JSON.parse(readFileSync(path.join(directory, file), "utf8")), critical);
      const installedLicenseFile = `consumer-${platform}-${mode}-licenses.json`;
      assert.ok(manifest.files[installedLicenseFile], "Missing installed consumer license report");
      assert.ok(receipt.checks.some((check) => check.mode === mode && check.licenses === installedLicenseFile && check.licenseSha256 === manifest.files[installedLicenseFile]), "Consumer license receipt mismatch");
      const installedReport = installedLicenses(JSON.parse(readFileSync(path.join(directory, file), "utf8")), JSON.parse(readFileSync(new URL("./license-exceptions.json", import.meta.url), "utf8")));
      assert.deepEqual(JSON.parse(readFileSync(path.join(directory, installedLicenseFile), "utf8")), installedReport, "Installed license evidence differs from SBOM");
      const nativeFile = `consumer-${platform}-${mode}-native.json`;
      assert.ok(manifest.files[nativeFile], "Missing native consumer inventory");
      assert.ok(receipt.checks.some((check) => check.mode === mode && check.nativeSnapshot === nativeFile && check.nativeSha256 === manifest.files[nativeFile]), "Native inventory receipt mismatch");
      const inventory = JSON.parse(readFileSync(path.join(directory, nativeFile), "utf8"));
      assert.equal(inventory.schema, 1); assert.ok(Array.isArray(inventory.files) && inventory.files.length);
      for (const entry of inventory.files) { assert.ok(typeof entry.path === "string" && !path.isAbsolute(entry.path) && !entry.path.split(/[\\/]/u).includes("..")); assert.match(entry.sha256, /^[a-f0-9]{64}$/u); }
      assert.ok(inventory.files.some((entry) => entry.path.includes("node-pty") && entry.path.endsWith(".node")), "PTY native inventory missing");
      assert.ok(inventory.files.some((entry) => entry.path.includes("codex") && /(?:codex|codex\.exe)$/u.test(entry.path)), "Codex native inventory missing");
    }
  }
  return manifest;
}
