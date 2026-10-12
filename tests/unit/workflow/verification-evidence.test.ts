import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { parseTestEvidence, parseCoverage, captureEvidenceReports, collectVerificationEvidence, invalidateVerificationEvidence, isVerificationEvidence } from "../../../src/workflow/verification-evidence.js";

test("test counts never imply actual assertions or independent verification", () => {
  assert.deepEqual(parseTestEvidence("TAP version 13\n1..0\n# tests 0\n", "tap"), { state: "reported", count: 0, assertions: "unknown" });
  assert.equal(parseTestEvidence("all tests passed", "tap").state, "unknown");
  assert.equal(parseTestEvidence('<testsuite tests="2"><testcase/><testcase><skipped/></testcase></testsuite>', "junit").skipped, 1);
  assert.equal(parseTestEvidence('<testsuite tests="8"><testcase/></testsuite>', "junit").state, "unknown");
  assert.equal(parseTestEvidence('<html>not a report</html>', "junit").state, "unknown");
});
test("coverage only maps bounded workspace files and retains unexecuted lines", () => {
  const root = path.resolve("fixture");
  const lcov = parseCoverage("SF:src/a.ts\nDA:1,1\nend_of_record\nSF:src/b.ts\nDA:2,0\nend_of_record\nSF:../outside.ts\nDA:1,1\nend_of_record", "lcov", root);
  assert.deepEqual([...lcov], [["src/a.ts", true], ["src/b.ts", false]]);
  assert.equal(parseCoverage('{"src/a.ts":{"s":{"0":1}}}', "istanbul", root).get("src/a.ts"), true);
  assert.equal(parseCoverage('{"src/a.ts":{"s":{"0":"1"}}}', "istanbul", root).size, 0);
});
test("preexisting report cannot become fresh evidence and workspace changes invalidate it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "everpeace-evidence-"));
  try {
    await mkdir(path.join(root, "coverage"));
    await writeFile(path.join(root, "junit.xml"), '<testsuite tests="1"><testcase/></testsuite>');
    const before = await captureEvidenceReports(root);
    const results = [{ command: { id: "node:test", label: "Tests", command: "pnpm test", tier: "full" as const, timeoutMs: 1000 }, passed: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false }];
    const context = { workspacePath: root, changedPaths: ["src/a.ts", "src/b.ts"], revision: "a".repeat(64) };
    const old = collectVerificationEvidence(results, context, before, await captureEvidenceReports(root));
    assert.equal(old.tests.state, "unknown");
    await writeFile(path.join(root, "junit.xml"), '<testsuite tests="2"><testcase/><testcase/></testsuite>');
    await writeFile(path.join(root, "coverage/lcov.info"), "SF:src/a.ts\nDA:1,1\nend_of_record");
    const fresh = collectVerificationEvidence(results, context, before, await captureEvidenceReports(root));
    assert.equal(fresh.tests.count, 2); assert.equal(fresh.coverage.state, "partial"); assert.equal(fresh.independent, "not_run");
    assert.equal(isVerificationEvidence(fresh), true);
    assert.equal(invalidateVerificationEvidence(fresh).tests.state, "unknown");
  } finally { await rm(root, { recursive: true, force: true }); }
});
