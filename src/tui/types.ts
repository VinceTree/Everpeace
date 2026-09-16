import type { AgentIO } from "../agent/react-agent.js";
import type {
  RegisteredModel,
  RegisteredModelStatus,
  ResolvedModels,
  StoredModelRegistration,
} from "../storage/model-registry.js";
import type { SessionStoreLike } from "../storage/session-store.js";
import type { BashResult } from "../tools/bash.js";

export interface AgentSession {
  runTurn(userInput: string, signal?: AbortSignal): Promise<void>;
}

export interface AgentRestoreOptions {
  initialContext?: readonly Record<string, unknown>[];
  onContextAppend?(items: readonly Record<string, unknown>[]): Promise<void>;
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
  runBash(command: string): Promise<BashResult>;
  runTerminalCommand(
    command: string,
    onOutput?: (output: string) => void,
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
  id: number;
  kind: HistoryKind;
  text: string;
}

export interface BannerEntry {
  id: number;
  kind: "banner";
  modelName?: string;
}

export type TimelineEntry = BannerEntry | HistoryEntry;
