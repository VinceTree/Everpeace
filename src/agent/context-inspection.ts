import { redactSecrets, type MemorySnapshot } from "../memory/learned-memory.js";
import type { McpSnapshot } from "../mcp/runtime.js";
import type { SkillTurnContext } from "../skills/catalog.js";
import type { ProjectRuleSnapshot } from "./project-context.js";
import type { RequestSnapshot } from "./request-snapshot.js";

export interface ContextAttachmentSummary {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export interface ContextPreview {
  kind: "project_rule" | "skill" | "memory" | "attachment" | "summary" | "conversation";
  label: string;
  text: string;
}

export interface ContextInspectionSnapshot {
  model: string;
  provider: string;
  submittedAt: string;
  contextRevision: number;
  requestFingerprint: string;
  estimatedInputTokens: number;
  estimateSource: "utf8_bytes_div_4";
  outputReserveTokens: number;
  componentBytes: {
    stableInstructions: number;
    dynamicInstructions: number;
  };
  projectRules: Array<{ path: string; scope: string; revision: string }>;
  projectRuleDiagnostics: Array<{ path: string; reason: string }>;
  skills: { advertised: string[]; explicitlyIncluded: string[] };
  memory: { revision?: string; entryIds: string[] };
  mcp: { servers: string[]; tools: string[] };
  advertisedTools: string[];
  itemCounts: Record<string, number>;
  opaqueItemBytes: Record<string, number>;
  attachments: ContextAttachmentSummary[];
  previews: ContextPreview[];
}

function inputTextBlocks(item: unknown): string[] {
  if (!item || typeof item !== "object" || Array.isArray(item)) return [];
  const content = (item as Record<string, unknown>).content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    block && typeof block === "object" && !Array.isArray(block) &&
    ((block as Record<string, unknown>).type === "input_text" ||
      (block as Record<string, unknown>).type === "output_text") &&
    typeof (block as Record<string, unknown>).text === "string"
      ? [(block as Record<string, unknown>).text as string]
      : []);
}

function requestInput(snapshot: RequestSnapshot): Array<Record<string, unknown>> {
  const input = snapshot.request.input;
  return Array.isArray(input)
    ? input.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function attachmentFromText(value: string): { summary: ContextAttachmentSummary; preview: ContextPreview } | undefined {
  if (!value.startsWith("<host_file_attachment ")) return undefined;
  const newline = value.indexOf("\n");
  if (newline < 0) return undefined;
  const close = value.indexOf(">", "<host_file_attachment ".length);
  if (close < 0 || close > newline) return undefined;
  try {
    const metadata = JSON.parse(value.slice("<host_file_attachment ".length, close)) as Record<string, unknown>;
    if (typeof metadata.path !== "string" || typeof metadata.start_line !== "number" || typeof metadata.end_line !== "number" || typeof metadata.total_lines !== "number") return undefined;
    const content = value.slice(newline + 1).replace(/\n<\/host_file_attachment>$/u, "");
    return {
      summary: {
        path: metadata.path,
        startLine: metadata.start_line,
        endLine: metadata.end_line,
        totalLines: metadata.total_lines,
        truncated: metadata.truncated === true,
      },
      preview: {
        kind: "attachment",
        label: `${metadata.path}:${metadata.start_line}-${metadata.end_line}`,
        text: redactSecrets(content, 2_000),
      },
    };
  } catch {
    return undefined;
  }
}

function countItems(input: readonly Record<string, unknown>[]): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (kind: string) => { counts[kind] = (counts[kind] ?? 0) + 1; };
  for (const item of input) {
    if (item.type === "function_call") add("tool_calls");
    else if (item.type === "function_call_output") add("tool_results");
    else if (item.type === "reasoning") add("opaque_reasoning");
    else if (item.role === "user") add("user_messages");
    else if (item.role === "assistant") add("assistant_messages");
    else if (item.role === "developer") {
      const summary = inputTextBlocks(item).some((text) => text.startsWith("Host-maintained conversation summary:"));
      add(summary ? "host_summaries" : "developer_messages");
    } else add(String(item.type ?? "opaque_items"));
  }
  return counts;
}

function opaqueItemBytes(input: readonly Record<string, unknown>[]): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const item of input) {
    const kind = item.type === "reasoning"
      ? "opaque_reasoning"
      : item.role === undefined && item.type !== "function_call" && item.type !== "function_call_output"
        ? String(item.type ?? "opaque_items")
        : undefined;
    if (kind) sizes[kind] = (sizes[kind] ?? 0) + byteLength(item);
  }
  return sizes;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

export function createContextInspectionSnapshot(options: {
  request: RequestSnapshot;
  model: string;
  provider: string;
  stableInstructions: string;
  dynamicInstructions: string;
  projectRules?: ProjectRuleSnapshot;
  skills?: SkillTurnContext;
  memory?: MemorySnapshot;
  learnedPrompt: string;
  mcp: McpSnapshot;
  tools: readonly Record<string, unknown>[];
  submittedAt?: string;
}): ContextInspectionSnapshot {
  const input = requestInput(options.request);
  const attachments: ContextAttachmentSummary[] = [];
  const previews: ContextPreview[] = [];
  const conversationPreviews: ContextPreview[] = [];
  for (const [index, item] of input.entries()) {
    for (const text of inputTextBlocks(item)) {
      const attachment = attachmentFromText(text);
      if (attachment) {
        attachments.push(attachment.summary);
        previews.push(attachment.preview);
      } else if (text.startsWith("Host-maintained conversation summary:")) {
        previews.push({ kind: "summary", label: "Host-maintained summary", text: redactSecrets(text, 2_000) });
      } else if ((item.role === "user" || item.role === "assistant") && text.trim()) {
        conversationPreviews.push({
          kind: "conversation",
          label: `${item.role === "user" ? "User" : "Assistant"} item ${index + 1}`,
          text: redactSecrets(text, 2_000),
        });
      }
    }
  }
  previews.push(...conversationPreviews.slice(-6));
  for (const rule of options.projectRules?.rules ?? []) {
    previews.push({ kind: "project_rule", label: `${rule.path} (${rule.scope})`, text: redactSecrets(rule.content, 2_000) });
  }
  if (options.skills?.explicitInstructions) {
    previews.push({ kind: "skill", label: options.skills.explicitNames.join(", ") || "Explicit skill instructions", text: redactSecrets(options.skills.explicitInstructions, 2_000) });
  }
  if (options.learnedPrompt) previews.push({ kind: "memory", label: `Learned memory ${options.memory?.revision ?? "snapshot"}`, text: redactSecrets(options.learnedPrompt, 2_000) });

  const snapshot: ContextInspectionSnapshot = {
    model: options.model,
    provider: options.provider,
    submittedAt: options.submittedAt ?? new Date().toISOString(),
    contextRevision: options.request.contextRevision,
    requestFingerprint: options.request.requestFingerprint,
    estimatedInputTokens: options.request.estimatedInputTokens,
    estimateSource: options.request.estimateSource,
    outputReserveTokens: options.request.outputReserveTokens,
    componentBytes: {
      stableInstructions: byteLength(options.stableInstructions),
      dynamicInstructions: byteLength(options.dynamicInstructions),
    },
    projectRules: (options.projectRules?.rules ?? []).map((rule) => ({ path: rule.path, scope: rule.scope, revision: rule.sha256 })),
    projectRuleDiagnostics: (options.projectRules?.diagnostics ?? []).map((diagnostic) => ({ ...diagnostic })),
    skills: {
      advertised: (options.skills?.skills ?? []).map((skill) => skill.name),
      explicitlyIncluded: [...(options.skills?.explicitNames ?? [])],
    },
    memory: {
      ...(options.memory?.revision ? { revision: options.memory.revision } : {}),
      entryIds: [...(options.memory?.entryIds ?? [])],
    },
    mcp: {
      servers: options.mcp.servers.map((server) => `${server.name} (${server.state})`),
      tools: options.mcp.tools.map((tool) => tool.name),
    },
    advertisedTools: options.tools.map((tool) => String(tool.name ?? "unknown")),
    itemCounts: countItems(input),
    opaqueItemBytes: opaqueItemBytes(input),
    attachments,
    previews,
  };
  return Object.freeze(structuredClone(snapshot));
}
