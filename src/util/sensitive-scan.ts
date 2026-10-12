export interface SensitiveFinding { rule: "token_prefix" | "bearer" | "assignment" | "url_credentials" | "private_key"; line: number }
const RULES: Array<{ rule: SensitiveFinding["rule"]; pattern: RegExp }> = [
  { rule: "token_prefix", pattern: /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|sk_(?:live|test)_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/gu },
  { rule: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu },
  { rule: "assignment", pattern: /["']?(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|password|passwd|secret|private[_ -]?key)["']?\s*[:=]\s*(?!["']?\[)(?:"(?:\\[\s\S]|[^"\\])+"|'[^']+'|[^\s,;"'}]+)/giu },
  { rule: "url_credentials", pattern: /(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/@]+:[^\s/@]+@[^\s/]+/giu },
  { rule: "private_key", pattern: /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu },
];
/** Only rule identifiers and line numbers leave this scanner. */
export function scanSensitiveText(value: string): SensitiveFinding[] {
  const findings: SensitiveFinding[] = [];
  const lineStarts = [0]; for (let i = 0; i < value.length; i++) if (value[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (offset: number) => { let low = 0; let high = lineStarts.length; while (low + 1 < high) { const middle = (low + high) >>> 1; if (lineStarts[middle]! <= offset) low = middle; else high = middle; } return low + 1; };
  for (const { rule, pattern } of RULES) {
    for (const match of value.matchAll(new RegExp(pattern.source, pattern.flags))) {
      if (rule === 'assignment' && isPublicCredentialExpression(match[0].replace(/^.*?[:=]\s*/su,''))) continue;
      findings.push({ rule, line: lineAt(match.index) });
      if (findings.length >= 1000) return findings;
    }
  }
  try {
    JSON.parse(value);
    for (const literal of value.matchAll(/"(?:\\[\s\S]|[^"\\])*"/gu)) {
      const decoded = JSON.parse(literal[0]) as string;
      if (!literal[0].includes("\\")) continue;
      for (const { rule, pattern } of RULES) {
        if (new RegExp(pattern.source, pattern.flags).test(decoded)) {
          const line = lineAt(literal.index);
          if (!findings.some((item) => item.rule === rule && item.line === line)) findings.push({ rule, line });
        }
      }
      if (findings.length >= 1000) break;
    }
  } catch { /* Non-JSON text was scanned directly. */ }
  return findings;
}
export function isPublicCredentialExpression(value: string): boolean {
  return /^(?:string|number|boolean|undefined|null|true|false|(?:process\.env|config|settings)\.[\w.]+|\$\{[A-Z0-9_]+\})$/u.test(value);
}

/** Join transport chunks before scanning so token prefixes and multiline keys span boundaries. */
export function scanSensitiveChunks(chunks: readonly string[], maximum = 1024 * 1024): { findings: SensitiveFinding[]; complete: boolean } {
  let text = '', complete = true;
  for (const chunk of chunks) { const available = maximum - text.length; if (chunk.length > available) {text += chunk.slice(0,available); complete = false; break;} text += chunk; }
  const findings = scanSensitiveText(text);
  return {findings, complete:complete && findings.length < 1000};
}
export function redactAdditionalSecrets(value: string): string {
  let result = value;
  for (const { rule, pattern } of RULES) {
    if (rule === "assignment" || rule === "private_key" || rule === "bearer") continue;
    result = result.replace(new RegExp(pattern.source, pattern.flags), rule === "url_credentials" ? "[URL credentials redacted]" : "[secret redacted]");
  }
  return result;
}
