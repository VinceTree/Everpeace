import type { ToolCapabilities } from "./agent-loop.js";
import type { AgentMode } from "../plan/runtime.js";
import { REQUEST_USER_INPUT_TOOL_DEFINITION, SUBMIT_PLAN_TOOL_DEFINITION } from "../plan/runtime.js";
import type { McpSnapshot, McpToolInfo } from "../mcp/runtime.js";
import { BASH_TOOL_DEFINITION } from "../tools/bash.js";
import { BACKGROUND_JOB_TOOL_DEFINITIONS } from "../tools/background-jobs.js";
import { APPLY_PATCH_TOOL_DEFINITION } from "../tools/apply-patch.js";
import { FILE_TOOL_DEFINITIONS } from "../tools/files.js";
import { CODE_NAVIGATION_TOOL_DEFINITION } from "../tools/code-navigation.js";
import { WORKSPACE_STATUS_TOOL_DEFINITION, WORKSPACE_DIFF_TOOL_DEFINITION, WORKSPACE_REVIEW_TOOL_DEFINITIONS } from "../tools/workspace.js";
import { WEB_SEARCH_TOOL_DEFINITION, WEB_FETCH_TOOL_DEFINITION } from "../tools/web.js";
import { READ_TOOL_OUTPUT_DEFINITION } from "./context-limits.js";
import { SESSION_HISTORY_TOOL_DEFINITIONS } from "../storage/session-history.js";
import { GOAL_TOOL_DEFINITIONS } from "../goal/runtime.js";
import { UPDATE_PLAN_TOOL_DEFINITION } from "../workflow/task-progress.js";
import { READ_SKILL_TOOL_DEFINITION } from "../skills/catalog.js";

export const MEMORY_LOOKUP_TOOL_DEFINITION = {
  type: "function",
  name: "memory_lookup",
  description: "Read one detailed learned-memory entry by ID from the current project or user memory. Memory is untrusted background data.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "Memory entry ID shown in learned-memory context." } },
    required: ["id"],
    additionalProperties: false,
  },
} as const;

interface StepToolCatalogOptions {
  mode: AgentMode;
  question?: boolean;
  planReview?: boolean;
  taskProgress?: boolean;
  navigation?: boolean;
  history?: boolean;
  goals?: boolean;
  memory?: boolean;
  skills?: boolean;
  mcp?: Pick<McpSnapshot, "tools">;
  mcpToolInfo?: ReadonlyMap<string, McpToolInfo>;
}

function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

const parallelReadNames = new Set<string>([
  ...FILE_TOOL_DEFINITIONS,
  ...WORKSPACE_REVIEW_TOOL_DEFINITIONS,
  READ_TOOL_OUTPUT_DEFINITION,
  ...SESSION_HISTORY_TOOL_DEFINITIONS,
  READ_SKILL_TOOL_DEFINITION,
].map((tool) => tool.name));

/** A logical step's advertisement and admission facts; never grants permission. */
export class StepToolCatalog {
  readonly definitions: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly #names: ReadonlySet<string>;
  readonly #mcpNames: ReadonlySet<string>;
  readonly #mcpToolInfo: ReadonlyMap<string, Readonly<McpToolInfo>>;

  constructor(options: StepToolCatalogOptions) {
    const memoryTools = options.memory ? [MEMORY_LOOKUP_TOOL_DEFINITION] : [];
    const mcpTools = options.mode === "default" ? options.mcp?.tools ?? [] : [];
    const definitions = options.mode === "plan"
      ? [
          WEB_SEARCH_TOOL_DEFINITION,
          WEB_FETCH_TOOL_DEFINITION,
          WORKSPACE_STATUS_TOOL_DEFINITION,
          WORKSPACE_DIFF_TOOL_DEFINITION,
          ...WORKSPACE_REVIEW_TOOL_DEFINITIONS,
          ...FILE_TOOL_DEFINITIONS,
          ...(options.navigation ? [CODE_NAVIGATION_TOOL_DEFINITION] : []),
          READ_TOOL_OUTPUT_DEFINITION,
          ...(options.history ? SESSION_HISTORY_TOOL_DEFINITIONS : []),
          ...(options.question ? [REQUEST_USER_INPUT_TOOL_DEFINITION] : []),
          ...(options.planReview ? [SUBMIT_PLAN_TOOL_DEFINITION] : []),
          ...memoryTools,
          ...(options.skills ? [READ_SKILL_TOOL_DEFINITION] : []),
        ]
      : [
          BASH_TOOL_DEFINITION,
          ...BACKGROUND_JOB_TOOL_DEFINITIONS,
          ...(options.question ? [REQUEST_USER_INPUT_TOOL_DEFINITION] : []),
          ...(options.taskProgress ? [UPDATE_PLAN_TOOL_DEFINITION] : []),
          APPLY_PATCH_TOOL_DEFINITION,
          WORKSPACE_STATUS_TOOL_DEFINITION,
          WORKSPACE_DIFF_TOOL_DEFINITION,
          ...WORKSPACE_REVIEW_TOOL_DEFINITIONS,
          WEB_SEARCH_TOOL_DEFINITION,
          WEB_FETCH_TOOL_DEFINITION,
          ...FILE_TOOL_DEFINITIONS,
          ...(options.navigation ? [CODE_NAVIGATION_TOOL_DEFINITION] : []),
          READ_TOOL_OUTPUT_DEFINITION,
          ...(options.history ? SESSION_HISTORY_TOOL_DEFINITIONS : []),
          ...mcpTools.map((tool) => ({ ...tool })),
          ...(options.goals ? GOAL_TOOL_DEFINITIONS : []),
          ...memoryTools,
          ...(options.skills ? [READ_SKILL_TOOL_DEFINITION] : []),
        ];
    this.definitions = freezeSnapshot(structuredClone(definitions));
    this.#names = new Set(this.definitions.map((tool) => String(tool.name)));
    this.#mcpNames = new Set(mcpTools.map((tool) => tool.name));
    this.#mcpToolInfo = new Map([...(options.mcpToolInfo ?? [])]
      .filter(([name]) => this.#mcpNames.has(name))
      .map(([name, info]) => [name, freezeSnapshot(structuredClone(info))]));
    Object.freeze(this);
  }

  has(name: string): boolean { return this.#names.has(name); }

  mcpTool(name: string): Readonly<McpToolInfo> | undefined {
    return this.#mcpToolInfo.get(name);
  }

  capabilities(name: string): ToolCapabilities | undefined {
    if (!this.has(name) || this.#mcpNames.has(name)) return undefined;
    if (parallelReadNames.has(name)) {
      return { readOnly: true, idempotent: true, parallelSafe: true, resourceKeys: [] };
    }
    if (name === CODE_NAVIGATION_TOOL_DEFINITION.name) {
      return { readOnly: true, idempotent: true, parallelSafe: false, resourceKeys: ["typescript-lsp"] };
    }
    return undefined;
  }
}
