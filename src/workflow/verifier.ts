import type { BashResult } from "../tools/bash.js";
import { retainOutput } from "../tools/command-record.js";
import { ProcessCleanupError } from "../tools/process-completion.js";
import {PROJECT_ADAPTERS} from '../projects/adapters.js';
import type { VerificationCommand, VerificationResult, VerificationSuiteResult, VerificationTier } from "./types.js";
import { verificationFromBash } from "./types.js";
import { captureEvidenceReports, collectVerificationEvidence, invalidateVerificationEvidence, type EvidenceContext } from "./verification-evidence.js";

const MAX_OUTPUT_BYTES=1024*1024;

export {discoverProjectChecks as discoverVerificationCommands} from '../projects/adapters.js';

function explainFailure(result:VerificationResult):VerificationResult{
  if(result.passed)return result;
  const adapter=PROJECT_ADAPTERS.find(adapter=>result.command.id.startsWith(adapter.kind+':'));
  if(!adapter)return result;
  const explanation=adapter.explain([result.error,result.stderr,result.stdout].filter(Boolean).join('\n'));
  const tool=explanation.missingTool;
  const knownTool=tool&&['node','npm','npm.cmd','pnpm','pnpm.cmd','yarn','yarn.cmd','bun','python','python3','pytest','cargo','rustc','go','tsc','eslint','tsx'].includes(tool.toLowerCase());
  return {...result,diagnostic:{category:explanation.category,...(knownTool?{missingTool:tool}:{})}};
}

export function selectVerificationCommands(
  commands: readonly VerificationCommand[],
  tier: VerificationTier,
): VerificationCommand[] {
  if (tier === "full") return commands.map((command) => ({ ...command }));
  const selected = selectVerificationCommand(commands, tier);
  return selected ? [{ ...selected }] : [];
}

export function selectVerificationCommand(
  commands: readonly VerificationCommand[],
  tier: VerificationTier,
): VerificationCommand | undefined {
  return commands.find((command) => command.tier === tier)
    ?? (tier === "full" ? commands.find((command) => command.tier === "fast") : undefined);
}

export async function runVerificationCommand(
  command: VerificationCommand,
  run: (command: string, signal?: AbortSignal, timeoutMs?: number) => Promise<BashResult>,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  signal?.throwIfAborted();
  const startedAt = Date.now();
  try {
    const result = await run(command.command, signal, command.timeoutMs);
    if (result.cleanupFailed) throw new ProcessCleanupError(result.error ?? "Verification process ownership is unresolved");
    signal?.throwIfAborted();
    return explainFailure(verificationFromBash(command, {
      ...result,
      stdout: retainOutput(result.stdout, MAX_OUTPUT_BYTES).text,
      stderr: retainOutput(result.stderr, MAX_OUTPUT_BYTES).text,
    }, Date.now() - startedAt));
  } catch (error) {
    if (error instanceof ProcessCleanupError || signal?.aborted) throw error;
    return explainFailure({
      command,
      passed: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: Date.now() - startedAt,
      timedOut: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function runVerificationSuite(
  commands: readonly VerificationCommand[],
  run: (command: string, signal?: AbortSignal, timeoutMs?: number) => Promise<BashResult>,
  signal?: AbortSignal,
  evidenceContext?: EvidenceContext,
): Promise<VerificationSuiteResult> {
  const before = evidenceContext ? await captureEvidenceReports(evidenceContext.workspacePath) : undefined;
  const withEvidence = async (suite: VerificationSuiteResult): Promise<VerificationSuiteResult> => {
    if (!evidenceContext || !before) return suite;
    const evidence = collectVerificationEvidence(suite.results, evidenceContext, before, await captureEvidenceReports(evidenceContext.workspacePath));
    return { ...suite, evidence: evidence.workspaceRevision ? evidence : invalidateVerificationEvidence(evidence) };
  };
  if (commands.length === 0) {
    return withEvidence({
      status: "unavailable",
      results: [],
      skipped: [],
      reason: "No conventional verification command was discovered",
    });
  }
  const results: VerificationResult[] = [];
  for (let index = 0; index < commands.length; index += 1) {
    signal?.throwIfAborted();
    const result = await runVerificationCommand(commands[index]!, run, signal);
    results.push(result);
    if (!result.passed) {
      return withEvidence({
        status: "failed",
        results,
        skipped: commands.slice(index + 1).map((command) => ({ ...command })),
      });
    }
  }
  return withEvidence({ status: "passed", results, skipped: [] });
}

export function verificationSuitePrompt(suite: VerificationSuiteResult): string {
  const failure = suite.results.find((result) => !result.passed);
  return failure ? verificationPrompt(failure) : suite.reason ?? "Verification was unavailable.";
}

export function verificationPrompt(result: VerificationResult): string {
  const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");
  return [
    `Verification failed: ${result.command.command} (exit ${result.exitCode ?? "unknown"}).`,
    output ? `Output:\n${output}` : result.error ?? "The command returned no output.",
    "Diagnose the failure, make a focused fix, and verify again. Do not claim completion until the check passes.",
  ].join("\n\n");
}
