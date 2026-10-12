import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseDocument } from "htmlparser2";
import { selectAll } from "css-select";
import type { VerificationEvidence, VerificationResult } from "./types.js";

const REPORTS = ["test-results.xml", "junit.xml", "reports/junit.xml", "coverage/junit.xml", "coverage/lcov.info", "coverage/coverage-final.json"];
const LIMIT = 4 * 1024 * 1024;
interface Report { text: string; digest: string; identity: string }
export interface EvidenceContext { workspacePath: string; changedPaths: readonly string[]; revision?: string; supplemental?: boolean; changedLines?: Readonly<Record<string, readonly number[]>> }
export type EvidenceReports = Map<string, Report>;

function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
export function isVerificationEvidence(value: unknown): value is VerificationEvidence {
  if (!value || typeof value !== "object") return false;
  const v = value as VerificationEvidence;
  const keys = (item: object, allowed: string[]) => Object.keys(item).every((key) => allowed.includes(key));
  return keys(v, ["version", "projectChecks", "tests", "coverage", "changedLines", "independent", "independentSource", "source", "modifiedTests", "workspaceRevision", "reportDigests"])
    && [1, 2].includes(v.version) && ["none", "static_or_build", "test_entry"].includes(v.projectChecks)
    && Boolean(v.tests) && ["reported", "unknown"].includes(v.tests.state) && v.tests.assertions === "unknown"
    && keys(v.tests, ["state", "count", "skipped", "assertions"])
    && (v.tests.count === undefined || count(v.tests.count)) && (v.tests.skipped === undefined || count(v.tests.skipped))
    && (v.tests.state !== "reported" || count(v.tests.count))
    && Boolean(v.coverage) && ["unknown", "uncovered", "partial", "covered"].includes(v.coverage.state)
    && keys(v.coverage, ["state", "changedFiles", "measuredFiles"])
    && count(v.coverage.changedFiles) && count(v.coverage.measuredFiles) && v.coverage.measuredFiles <= v.coverage.changedFiles
    && (v.changedLines === undefined || keys(v.changedLines, ["state", "total", "measured", "covered"]) && ["unknown", "uncovered", "partial", "covered"].includes(v.changedLines.state) && count(v.changedLines.total) && count(v.changedLines.measured) && count(v.changedLines.covered) && v.changedLines.covered <= v.changedLines.measured && v.changedLines.measured <= v.changedLines.total)
    && (v.independentSource === undefined || keys(v.independentSource, ["id", "digest"]) && /^[A-Za-z0-9_-]{1,100}$/u.test(v.independentSource.id) && /^[a-f0-9]{64}$/u.test(v.independentSource.digest))
    && ["not_run", "passed", "failed"].includes(v.independent) && ["project_checks", "supplemental_check"].includes(v.source)
    && (v.version === 1 || v.independent === 'not_run' || v.independentSource !== undefined)
    && typeof v.modifiedTests === "boolean" && (v.workspaceRevision === undefined || /^[a-f0-9]{64}$/u.test(v.workspaceRevision))
    && Array.isArray(v.reportDigests) && v.reportDigests.length <= REPORTS.length && v.reportDigests.every((d) => /^[a-f0-9]{64}$/u.test(d));
}

/** Read only fixed report locations without following project-provided links. */
export async function captureEvidenceReports(workspacePath: string): Promise<EvidenceReports> {
  const root = await fs.realpath(workspacePath);
  const reports: EvidenceReports = new Map();
  for (const name of REPORTS) {
    try {
      let current = root;
      for (const component of name.split("/")) {
        current = path.join(current, component);
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Linked report");
      }
      const before = await fs.lstat(current);
      if (!before.isFile() || before.size > LIMIT) continue;
      const handle = await fs.open(current, "r");
      try {
        const opened = await handle.stat();
        if (opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) continue;
        const buffer = Buffer.alloc(opened.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const after = await fs.lstat(current);
        if (bytesRead !== opened.size || after.isSymbolicLink() || after.ino !== opened.ino || after.mtimeMs !== opened.mtimeMs || after.size !== opened.size) continue;
        if (await fs.realpath(current) !== current) continue;
        const text = buffer.subarray(0, bytesRead).toString("utf8");
        reports.set(name, { text, digest: createHash("sha256").update(text).digest("hex"), identity: `${opened.ino}:${opened.size}:${opened.mtimeMs}:${opened.ctimeMs}` });
      } finally { await handle.close(); }
    } catch { /* Missing, racing or unreadable evidence stays unknown. */ }
  }
  return reports;
}

export function parseTestEvidence(text: string, format: "tap" | "junit"): VerificationEvidence["tests"] {
  if (format === "tap") {
    if (!/^TAP version 13\s*$/mu.test(text)) return { state: "unknown", assertions: "unknown" };
    const total = /^# tests (\d+)\s*$/mu.exec(text)?.[1] ?? /^1\.\.(\d+)\s*(?:#.*)?$/mu.exec(text)?.[1];
    const skipped = /^# skipped (\d+)\s*$/mu.exec(text)?.[1];
    if (total !== undefined && count(Number(total))) return { state: "reported", count: Number(total), ...(skipped === undefined ? {} : { skipped: Number(skipped) }), assertions: "unknown" };
  } else {
    const document = parseDocument(text, { xmlMode: true });
    if (!selectAll("testsuite, testsuites", document).length) return { state: "unknown", assertions: "unknown" };
    const cases = selectAll("testcase", document);
    const roots = selectAll("testsuites", document);
    const suites = selectAll("testsuite", document);
    const attribute = (node: unknown): string | undefined => {
      if (!node || typeof node !== "object" || !("attribs" in node) || !node.attribs || typeof node.attribs !== "object" || !("tests" in node.attribs)) return;
      return typeof node.attribs.tests === "string" ? node.attribs.tests : undefined;
    };
    const declared = attribute(roots[0]) ?? (suites.length === 1 ? attribute(suites[0]) : undefined);
    if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) !== cases.length)) return { state: "unknown", assertions: "unknown" };
    return { state: "reported", count: cases.length, skipped: cases.filter((entry) => selectAll("skipped", entry).length > 0).length, assertions: "unknown" };
  }
  return { state: "unknown", assertions: "unknown" };
}

function relativeFile(root: string, value: string): string | undefined {
  const relative = path.relative(root, path.isAbsolute(value) ? value : path.resolve(root, value)).replaceAll("\\", "/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return;
  return process.platform === "win32" ? relative.toLowerCase() : relative;
}
export function parseCoverage(text: string, format: "lcov" | "istanbul", root: string): Map<string, boolean> {
  const files = new Map<string, boolean>();
  if (format === "lcov") {
    for (const record of text.split("end_of_record")) {
      const name = /^SF:(.+)$/mu.exec(record)?.[1]?.trim();
      const lines = [...record.matchAll(/^DA:\d+,(\d+)(?:,.*)?$/gmu)];
      const relative = name ? relativeFile(root, name) : undefined;
      if (relative && lines.length) files.set(relative, (files.get(relative) ?? false) || lines.some((line) => Number(line[1]) > 0));
    }
  } else {
    try {
      const report: unknown = JSON.parse(text);
      if (!report || typeof report !== "object" || Array.isArray(report)) return files;
      for (const [name, value] of Object.entries(report)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const entry = value as { path?: unknown; s?: unknown };
        const relative = relativeFile(root, typeof entry.path === "string" ? entry.path : name);
        if (!relative || !entry.s || typeof entry.s !== "object" || Array.isArray(entry.s)) continue;
        const hits = Object.values(entry.s);
        if (hits.length && hits.every(count)) files.set(relative, hits.some((hit) => (hit as number) > 0));
      }
    } catch { /* Invalid report is not evidence. */ }
  }
  return files;
}

export function collectVerificationEvidence(results: readonly VerificationResult[], context: EvidenceContext, before: EvidenceReports, after: EvidenceReports): VerificationEvidence {
  const fresh = [...after].filter(([name, value]) => before.get(name)?.identity !== value.identity || before.get(name)?.digest !== value.digest);
  let tests: VerificationEvidence["tests"] = { state: "unknown", assertions: "unknown" };
  const executedTests = results.filter((r) => /^(?:node:test|python:pytest|rust:test|go:test)$/u.test(r.command.id));
  for (const result of executedTests) {
    const parsed = parseTestEvidence(`${result.stdout}\n${result.stderr}`, "tap");
    if (parsed.state === "reported") tests = parsed;
  }
  const measured = new Map<string, boolean>();
  const lineHits = new Map<string, Map<number, boolean>>();
  for (const [name, report] of fresh) {
    if (name.endsWith(".xml") && executedTests.length) {
      const parsed = parseTestEvidence(report.text, "junit");
      if (parsed.state === "reported") tests = parsed;
    }
    if (name.endsWith("lcov.info") || name.endsWith("coverage-final.json")) {
      for (const [file, covered] of parseCoverage(report.text, name.endsWith(".json") ? "istanbul" : "lcov", context.workspacePath)) measured.set(file, (measured.get(file) ?? false) || covered);
      for (const [file, lines] of parseCoverageLines(report.text, name.endsWith(".json") ? "istanbul" : "lcov", context.workspacePath)) {
        const hits = lineHits.get(file) ?? new Map<number, boolean>();
        for (const [line, covered] of lines) hits.set(line, (hits.get(line) ?? false) || covered);
        lineHits.set(file, hits);
      }
    }
  }
  const changed = [...new Set(context.changedPaths.map((p) => relativeFile(context.workspacePath, p)).filter((p): p is string => p !== undefined))];
  const measuredFiles = changed.filter((p) => measured.has(p)).length;
  const coveredFiles = changed.filter((p) => measured.get(p) === true).length;
  let total = 0, measuredLines = 0, coveredLines = 0, mappedFiles = 0;
  for (const file of changed) {
    const lines = context.changedLines?.[file];
    if (!lines) continue;
    mappedFiles++;
    for (const line of new Set(lines)) { total++; if (lineHits.get(file)?.has(line)) measuredLines++; if (lineHits.get(file)?.get(line)) coveredLines++; }
  }
  const lineState = !total || !measuredLines ? "unknown" : coveredLines === total && mappedFiles === changed.length ? "covered" : coveredLines === 0 && measuredLines === total && mappedFiles === changed.length ? "uncovered" : "partial";
  return {
    version: 2, projectChecks: !results.length ? "none" : executedTests.length ? "test_entry" : "static_or_build", tests,
    changedLines: { state: lineState, total, measured: measuredLines, covered: coveredLines },
    coverage: { state: !measuredFiles ? "unknown" : !coveredFiles ? "uncovered" : coveredFiles === changed.length ? "covered" : "partial", changedFiles: changed.length, measuredFiles },
    independent: "not_run", source: context.supplemental ? "supplemental_check" : "project_checks",
    modifiedTests: context.changedPaths.some((p) => /(?:^|[\\/])(?:tests?|__tests__)(?:[\\/]|$)|\.(?:test|spec)\.[^/]+$/iu.test(p)),
    ...(context.revision && /^[a-f0-9]{64}$/u.test(context.revision) ? { workspaceRevision: context.revision } : {}),
    reportDigests: fresh.map(([, value]) => value.digest),
  };
}

export function invalidateVerificationEvidence(evidence: VerificationEvidence): VerificationEvidence {
  const result = { ...evidence, tests: { state: "unknown" as const, assertions: "unknown" as const }, coverage: { ...evidence.coverage, state: "unknown" as const, measuredFiles: 0 }, independent: "not_run" as const, reportDigests: [] };
  delete result.workspaceRevision;
  delete result.independentSource;
  if (result.changedLines) result.changedLines = { ...result.changedLines, state: "unknown", measured: 0, covered: 0 };
  return result;
}
export function formatVerificationEvidence(evidence?: VerificationEvidence): string {
  if (!evidence) return "Verification evidence: unavailable. Independent functional verification: not run.";
  const tests = evidence.tests.state === "reported" ? `${evidence.tests.count} reported tests (assertions unknown)` : "test count and assertions unknown";
  const suggestion = evidence.projectChecks !== "test_entry" || evidence.tests.count === 0 || evidence.coverage.state === "uncovered" ? " Add targeted tests for the changed behavior." : "";
  return `Project evidence: ${evidence.projectChecks}; ${tests}; file execution evidence: ${evidence.coverage.state}; modified-line coverage: ${evidence.changedLines?.state ?? "unknown"}. Independent functional verification: ${evidence.independent.replaceAll("_", " ")}.${suggestion}`;
}

/** Only a host-owned verifier may attach independent acceptance provenance. */
export function bindIndependentVerification(evidence: VerificationEvidence, result: { passed: boolean; workspaceRevision: string; source: { id: string; digest: string } }): VerificationEvidence {
  if (evidence.workspaceRevision !== result.workspaceRevision || !/^[a-f0-9]{64}$/u.test(result.workspaceRevision) || !/^[A-Za-z0-9_-]{1,100}$/u.test(result.source.id) || !/^[a-f0-9]{64}$/u.test(result.source.digest)) throw new Error('Independent verification provenance or revision is invalid');
  return { ...evidence, version: 2, independent: result.passed ? 'passed' : 'failed', independentSource: { ...result.source } };
}

export function parseCoverageLines(text: string, format: "lcov" | "istanbul", root: string): Map<string, Map<number, boolean>> {
  const files = new Map<string, Map<number, boolean>>();
  const hit = (file: string, line: number, covered: boolean) => { if (!Number.isSafeInteger(line) || line < 1) return; const lines = files.get(file) ?? new Map<number, boolean>(); lines.set(line, (lines.get(line) ?? false) || covered); files.set(file, lines); };
  if (format === "lcov") {
    for (const record of text.split("end_of_record")) {
      const name = /^SF:(.+)$/mu.exec(record)?.[1]?.trim(); const file = name ? relativeFile(root, name) : undefined;
      if (file) for (const match of record.matchAll(/^DA:(\d+),(\d+)(?:,.*)?$/gmu)) { const n = Number(match[2]); if (count(n)) hit(file, Number(match[1]), n > 0); }
    }
  } else {
    try {
      const report = JSON.parse(text) as Record<string, {path?: string; s?: Record<string, number>; statementMap?: Record<string, {start?: {line?: number}}>}>;
      for (const [name, entry] of Object.entries(report)) {
        if (!entry || typeof entry !== "object") continue;
        const file = relativeFile(root, typeof entry.path === "string" ? entry.path : name);
        if (file && entry.s && entry.statementMap) for (const [id, n] of Object.entries(entry.s)) { const line = entry.statementMap[id]?.start?.line; if (count(n) && typeof line === "number") hit(file, line, n > 0); }
      }
    } catch { /* Unmapped statements remain unknown. */ }
  }
  return files;
}
