import type { AgentIO } from "../agent/react-agent.js";
import type {
  RegisteredModel,
  RegisteredModelStatus,
  ResolvedModels,
  StoredModelRegistration,
} from "../storage/model-registry.js";
import type { BashResult } from "../tools/bash.js";

export interface AgentSession {
  runTurn(userInput: string, signal?: AbortSignal): Promise<void>;
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
  listModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]>;
  createAgent(model: RegisteredModel, io: AgentIO): AgentSession;
  runBash(command: string): Promise<BashResult>;
  runTerminalCommand(command: string): Promise<BashResult>;
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
