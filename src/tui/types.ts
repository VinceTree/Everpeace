import type { AgentIO } from "../agent/react-agent.js";
import type { CommandRecord } from "../tools/command-record.js";
import type { InputHistoryStore } from "../storage/input-history.js";
import type {
  RegisteredModel,
  RegisteredModelStatus,
  ResolvedModels,
  StoredModelRegistration,
} from "../storage/model-registry.js";
import type { SessionStoreLike } from "../storage/session-store.js";
import type { BashResult } from "../tools/bash.js";
import type {
  StatusSnapshot,
  TokenUsageSample,
} from "../status/model-status.js";

export interface AgentSession {
  runTurn(userInput: string, signal?: AbortSignal): Promise<void>;
}

export interface AgentRestoreOptions {
  initialContext?: readonly Record<string, unknown>[];
  onContextAppend?(items: readonly Record<string, unknown>[]): Promise<void>;
  onUsage?(usage: TokenUsageSample | null): Promise<void>;
}

export interface TuiModelRegistry {
  resolveAll(): Promise<ResolvedModels>;
  listStatuses(): Promise<RegisteredModelStatus[]>;
  registerMany(
    baseUrl: string,
    modelNames: readonly string[],
    apiKey: string,
  ): Promise<StoredModelRegistration[]>;
  removeMany(ids: readonly string[]): Promise<StoredModelRegistration[]>;
}

export interface TuiDependencies {
  inputHistory?: InputHistoryStore;
  registry: TuiModelRegistry;
  version: string;
  workspacePath: string;
  sessionStore: SessionStoreLike;
  listModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]>;
  createAgent(
    model: RegisteredModel,
    io: AgentIO,
    restore?: AgentRestoreOptions,
  ): AgentSession;
  generateSessionTitle(
    model: RegisteredModel,
    firstQuestion: string,
    signal?: AbortSignal,
  ): Promise<string>;
  changeWorkspace(workspacePath: string): Promise<string>;
  runBash(command: string, signal?: AbortSignal, onOutput?: (output: string) => void): Promise<BashResult>;
  runTerminalCommand(
    command: string,
    onOutput?: (output: string) => void,
    signal?: AbortSignal,
    onInputReady?: (write: ((input: string) => void) | undefined) => void,
  ): Promise<BashResult>;
}

export type HistoryKind =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "output"
  | "error";

export interface HistoryEntry {
  command?: CommandRecord;
  id: number;
  kind: HistoryKind;
  text: string;
}

export interface BannerEntry {
  id: number;
  kind: "banner";
  modelName?: string;
}

export interface StatusEntry {
  id: number;
  kind: "status";
  snapshot: StatusSnapshot;
}

export type TimelineEntry = BannerEntry | HistoryEntry | StatusEntry;
