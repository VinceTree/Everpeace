export interface CommandRecord {
  id: string;
  command: string;
  shell: string;
  workspace: string;
  source: "user" | "model";
  status: "completed" | "failed" | "cancelled";
  durationMs: number;
  truncated: boolean;
}

export function isCommandRecord(value: unknown): value is CommandRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return [v.id, v.command, v.shell, v.workspace].every((s) => typeof s === "string") &&
    (v.source === "user" || v.source === "model") &&
    ["completed", "failed", "cancelled"].includes(String(v.status)) &&
    typeof v.durationMs === "number" && Number.isFinite(v.durationMs) && v.durationMs >= 0 && typeof v.truncated === "boolean";
}

export function retainOutput(text: string, maxBytes = 2 * 1024 * 1024): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  let retained = lines.slice(-10000).join("\n");
  let truncated = lines.length > 10000;
  if (Buffer.byteLength(retained) > maxBytes) {
    const bytes = Buffer.from(retained);
    let start = bytes.length - maxBytes;
    while ((bytes[start]! & 0xc0) === 0x80) start += 1;
    retained = bytes.subarray(start).toString("utf8");
    truncated = true;
  }
  return { text: retained, truncated };
}
