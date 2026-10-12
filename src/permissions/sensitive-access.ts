import { uiText } from "../localization/messages.js";
import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { scanSensitiveText } from '../util/sensitive-scan.js';
import { redactSecretsPreservingLayout } from '../util/redact-secrets.js';

export type SensitiveDecision = 'redact' | 'allow' | 'deny';
export const SENSITIVE_CONTEXT_MARKER = 'Host sensitive-context boundary: external actions require fresh approval.';
export function sensitivePath(value: string): boolean {
  return value.split(/[\\/]/u).some((part) => /^(?:.*\.everpeace-(?:recovery|stage)-.*|\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.ssh|\.aws|\.azure|\.kube|credentials(?:\.json)?|id_(?:rsa|ed25519|ecdsa)(?:\..*)?|.*\.(?:pem|p12|pfx|key))$/iu.test(part));
}
export function sensitiveText(value: string): boolean { return scanSensitiveText(value).length > 0; }
export function sensitiveDigest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function safeApprovalText(value: string): string { return redactSecretsPreservingLayout(stripVTControlCharacters(value)).slice(0, 16_384); }

/** One host boundary covers tool outputs, attachments, rules and user text before persistence. */
export class SensitiveAccessGuard {
  sensitive = false;
  constructor(readonly decide?: (summary: string, signal?: AbortSignal) => Promise<SensitiveDecision>) {}
  async protect(value: string, source: string, revision: () => string, signal?: AbortSignal, pathSensitive = false): Promise<string> {
    if (!pathSensitive && !sensitiveText(value)) return value;
    const before = revision();
    const decision = await this.decide?.(uiText("security.readPrompt", { p0: JSON.stringify(source), p1: sensitiveDigest(value) }), signal) ?? 'redact';
    signal?.throwIfAborted();
    if (revision() !== before) throw new Error('Sensitive access approval expired after policy changed');
    if (decision === 'deny') throw new Error('Sensitive content access rejected');
    if (decision === 'allow') { this.sensitive = true; return value; }
    // Filename classification may cover credentials unrecognizable to the scanner.
    return pathSensitive ? '[sensitive file content withheld; request explicit original-text authorization]' : redactSecretsPreservingLayout(value);
  }
}
