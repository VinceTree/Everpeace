import { retainOutput } from "../tools/command-record.js";

export const MAX_MCP_RESULT_BYTES = 1024 * 1024;
export const MAX_MCP_PAGE_ITEMS = 1_000;

type McpResultKind = "tool" | "resource" | "prompt";

function binaryDescription(record: Record<string, unknown>, data: string): string {
  return `[binary content unavailable: ${typeof record.mimeType === "string" ? record.mimeType : "unknown MIME type"}; ${data.length} base64 characters]`;
}

function projectResource(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return typeof record.blob === "string" ? { ...record, blob: binaryDescription(record, record.blob) } : value;
}

function projectContentBlock(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if ((record.type === "image" || record.type === "audio") && typeof record.data === "string") {
    return { ...record, data: binaryDescription(record, record.data) };
  }
  if (record.type === "resource") return { ...record, resource: projectResource(record.resource) };
  return value;
}

/** Only protocol content positions contain binary bodies. Business JSON and _meta are opaque. */
function projectMcpResult(value: unknown, kind: McpResultKind): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (kind === "tool" && Array.isArray(record.content)) return { ...record, content: record.content.map(projectContentBlock) };
  if (kind === "resource" && Array.isArray(record.contents)) return { ...record, contents: record.contents.map(projectResource) };
  if (kind === "prompt" && Array.isArray(record.messages)) {
    return { ...record, messages: record.messages.map((message: unknown) => {
      if (!message || typeof message !== "object") return message;
      const entry = message as Record<string, unknown>;
      return { ...entry, content: projectContentBlock(entry.content) };
    }) };
  }
  return value;
}

/** Preserve a complete list page and its server cursor, or reject the whole page. */
export function serializeMcpPage(server: string, key: "resources" | "resourceTemplates" | "prompts", page: Record<string, unknown>): string {
  const items = page[key];
  if (!Array.isArray(items)) throw new Error(`MCP ${key} response did not contain a list`);
  const value = {
    status: "ok",
    server,
    [key]: items,
    ...(page._meta === undefined ? {} : { _meta: page._meta }),
    ...(typeof page.nextCursor === "string" ? { next_cursor: page.nextCursor } : {}),
  };
  const serialized = JSON.stringify(value);
  if (items.length > MAX_MCP_PAGE_ITEMS || Buffer.byteLength(serialized, "utf8") > MAX_MCP_RESULT_BYTES) {
    // A remote cursor points after the entire page. Returning it with a partial
    // page would silently make omitted items unreachable.
    return JSON.stringify({
      status: "error",
      code: "range_error",
      server,
      incomplete: true,
      error: `MCP ${key} page exceeds ${MAX_MCP_PAGE_ITEMS} items or ${MAX_MCP_RESULT_BYTES} bytes; no partial page was returned. Ask the server to provide smaller pages.`,
    });
  }
  return serialized;
}

/** Retain bounded, valid JSON after binary projection, including its envelope. */
export function serializeMcpResult(value: unknown, kind: McpResultKind = "tool"): string {
  const serialized = JSON.stringify(projectMcpResult(value, kind));
  if (Buffer.byteLength(serialized, "utf8") <= MAX_MCP_RESULT_BYTES) return serialized;
  let maximum = MAX_MCP_RESULT_BYTES - 128;
  while (true) {
    const text = retainOutput(serialized, maximum).text;
    const result = JSON.stringify({ status: "truncated", output: text });
    const excess = Buffer.byteLength(result, "utf8") - MAX_MCP_RESULT_BYTES;
    if (excess <= 0) return result;
    maximum = Math.max(0, maximum - excess);
  }
}
