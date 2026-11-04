import { redactSecretsPreservingLayout } from "../util/redact-secrets.js";

/** The same semantic text is used for capture, source hashes and history paging. */
export function sessionMessageText(item: Record<string, unknown>): string | undefined {
  if (item.role !== "user" && item.role !== "assistant") return undefined;
  if (item.type !== undefined && item.type !== "message") return undefined;
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return undefined;
  return item.content.flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    const part = raw as { type?: unknown; text?: unknown };
    return ["input_text", "output_text", "text"].includes(String(part.type)) && typeof part.text === "string" ? [part.text] : [];
  }).join("\n");
}

export function sessionMessageBody(item: Record<string, unknown>): string | undefined {
  const text = sessionMessageText(item);
  return text === undefined ? undefined : redactSecretsPreservingLayout(text);
}
