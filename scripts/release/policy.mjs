import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const nativeTests = [
  "native workspace profile blocks model shell writes to .everpeace",
  "native Windows sandbox cancellation stops a detached payload descendant",
  "native LSP profile denies writes, state reads and direct networking",
  "native team sandbox proves root/state/Git denial before coding, or fails closed",
  "two production workers integrate independently and only the root native check determines success",
];

export function candidateSha(value) {
  assert.match(value ?? "", /^[a-f0-9]{40}$/u, "A full lowercase commit SHA is required");
  return value;
}

export function requirePortableBuild(platform, arch) {
  assert.equal(platform, "linux", "Portable candidates must be built on Linux; Windows packing is development only");
  assert.equal(arch, "x64", "Portable candidates currently require the tested Linux x64 toolchain");
}

export function requireSuccess(results, required) {
  for (const name of required) assert.equal(results[name]?.result ?? results[name], "success", `Required check ${name} did not succeed`);
}

export function digest(file, algorithm = "sha256") {
  return createHash(algorithm).update(readFileSync(file)).digest("hex");
}

export function verifyPackage(receipt, file, expectedSha, expectedDigest, requireClean = true) {
  assert.equal(receipt.schema, 1, "Unknown package receipt schema");
  assert.equal(receipt.commit, candidateSha(expectedSha), "Package belongs to another candidate");
  if (requireClean) assert.equal(receipt.dirty, false, "Package source was dirty");
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.sha256, expectedDigest, "Package differs from the build job output");
  assert.equal(digest(file), expectedDigest, "Package bytes differ from the receipt");
  assert.match(receipt.filename, /^everpeace-[0-9A-Za-z.+-]+\.tgz$/u);
  assert.equal(receipt.filename, `everpeace-${receipt.version}.tgz`);
}

export function requireNativeResults(events) {
  for (const name of nativeTests) {
    const matches = events.filter((event) => event.data?.name === name && ["test:pass", "test:fail"].includes(event.type));
    assert.equal(matches.length, 1, `Required native test missing or duplicated: ${name}`);
    const result = matches[0];
    assert.equal(result.type, "test:pass", `Native test failed: ${name}`);
    assert.ok(!result.data.skip && !result.data.todo, `Native test skipped: ${name}`);
  }
}
