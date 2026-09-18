import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { ReactAgent, type AgentIO, type ResponsesClientLike } from "../agent/react-agent.js";
import {
  createProviderClient,
  listOfficialModelIds,
} from "../providers/openai-compatible.js";
import type { RegisteredModel } from "../storage/model-registry.js";
import { SessionStore } from "../storage/session-store.js";
import { InputHistory } from "../storage/input-history.js";
import { runBash } from "../tools/bash.js";
import { runTerminalCommand } from "../tools/terminal.js";
import type { TuiDependencies, TuiModelRegistry } from "./types.js";
import { truncateEnd } from "./text-width.js";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as { version?: unknown };

function packageVersion(): string {
  return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
}

export function sanitizeSessionTitle(value: string): string {
  const line = value
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find(Boolean) ?? "";
  const cleaned = line
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^[`*_]+|[`*_]+$/g, "")
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .replace(/[。.!！?？:：;；]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncateEnd(cleaned, 60);
}

export function createDefaultTuiDependencies(
  registry: TuiModelRegistry,
): TuiDependencies {
  const sessionStore = new SessionStore();
  return {
    registry,
    version: packageVersion(),
    workspacePath: process.cwd(),
    sessionStore,
    inputHistory: new InputHistory(),
    async listModels(baseUrl, apiKey, signal) {
      return listOfficialModelIds(createProviderClient(baseUrl, apiKey), signal);
    },
    createAgent(model: RegisteredModel, io: AgentIO, restore) {
      return new ReactAgent({
        workspacePath: process.cwd(),
        client: createProviderClient(
          model.base_url,
          model.api_key,
        ) as unknown as ResponsesClientLike,
        model: model.model_name,
        io,
        ...(restore?.initialContext === undefined
          ? {}
          : { initialHistory: restore.initialContext }),
        ...(restore?.onContextAppend === undefined
          ? {}
          : { onHistoryAppend: restore.onContextAppend }),
        ...(restore?.onUsage === undefined
          ? {}
          : { onUsage: restore.onUsage }),
        ...(restore?.onPhase === undefined
          ? {}
          : { onPhase: restore.onPhase }),
      });
    },
    async generateSessionTitle(model, firstQuestion, signal) {
      const client = createProviderClient(model.base_url, model.api_key);
      const response = await client.responses.create(
        {
          model: model.model_name,
          instructions:
            "Summarize the user's request as one concise session title. " +
            "Use the same language as the request. Return only the title, " +
            "without Markdown, quotation marks, or ending punctuation.",
          input: firstQuestion,
          store: false,
        },
        signal === undefined ? undefined : { signal },
      );
      const title = sanitizeSessionTitle(response.output_text);
      if (!title) throw new Error("The model returned an empty session title");
      return title;
    },
    async changeWorkspace(workspacePath) {
      const stats = await fs.stat(workspacePath);
      if (!stats.isDirectory()) throw new Error(`Session workspace is not a directory: ${workspacePath}`);
      process.chdir(workspacePath);
      return process.cwd();
    },
    runBash(command, signal, onOutput) {
      return runBash(command, { streamOutput: false, ...(signal ? { signal } : {}), ...(onOutput ? { onOutput } : {}) });
    },
    runTerminalCommand(command, onOutput, signal, onInputReady) {
      return runTerminalCommand(command, {
        streamOutput: false,
        ...(signal ? { signal } : {}),
        ...(onInputReady ? { onInputReady } : {}),
        ...(onOutput === undefined ? {} : { onOutput }),
      });
    },
  };
}
