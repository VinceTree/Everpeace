import { redactAdditionalSecrets } from "./sensitive-scan.js";

function redactPrivateKeys(value: string): string {
  return value.replace(/-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/giu, (secret) =>
    secret.replace(/[^\r\n]+/gu, (line) => `${line.match(/^[\t ]*/u)?.[0] ?? ""}[private key redacted]`),
  );
}

function redactJsonStringSecrets(value: string): string {
  try {
    JSON.parse(value);
  } catch {
    return redactPrivateKeys(value);
  }
  // Decode escaped string contents without consuming their JSON delimiter.
  // Unchanged literals retain their original escaping and surrounding layout.
  return value.replace(/"(?:\\[\s\S]|[^"\\])*"/gu, (literal) => {
    const decoded = JSON.parse(literal) as string;
    const redacted = redactAdditionalSecrets(redactPlainSecrets(decoded, true));
    return decoded === redacted ? literal : JSON.stringify(redacted);
  });
}

function redactPlainSecrets(value: string, preserveValueQuotes: boolean): string {
  const redacted = redactPrivateKeys(value)
    .replace(/\b(?:sk-[A-Za-z0-9]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/gu, "[secret redacted]")
    .replace(/\bBearer(\s+)[A-Za-z0-9._~+/=-]{12,}/giu, "Bearer$1[secret redacted]");
  if (!preserveValueQuotes) {
    return redacted.replace(/(["']?(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|password|passwd|secret|private[_ -]?key)["']?\s*[:=]\s*)["']?[^\s,;"'}]+["']?/giu, "$1[secret redacted]");
  }
  return redacted.replace(/(["']?(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|password|passwd|secret|private[_ -]?key)["']?\s*[:=]\s*)(?!["']?\[(?:secret|private key) redacted\])("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;"'}]+)/giu,
    (_secret, prefix: string, credential: string) => {
      const quote = credential[0] === '"' || credential[0] === "'" ? credential[0] : "";
      const body = quote ? credential.slice(1, -1) : credential;
      const replacement = body.replace(/[^\r\n]+/gu, (line) => `${line.match(/^[\t ]*/u)?.[0] ?? ""}[secret redacted]`);
      return `${prefix}${quote}${replacement || "[secret redacted]"}${quote}`;
    },
  );
}

/** Redact before retaining or paging text; false preserves legacy Memory quote handling. */
export function redactSecretsPreservingLayout(value: string, preserveValueQuotes = true): string {
  return redactAdditionalSecrets(redactPlainSecrets(preserveValueQuotes ? redactJsonStringSecrets(value) : value, preserveValueQuotes));
}
