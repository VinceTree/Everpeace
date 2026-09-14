import { createRequire } from "node:module";
import { ReactAgent, type AgentIO, type ResponsesClientLike } from "../agent/react-agent.js";
import {
  createProviderClient,
  listOfficialModelIds,
} from "../providers/openai-compatible.js";
import type { RegisteredModel } from "../storage/model-registry.js";
import { runBash } from "../tools/bash.js";
import { runTerminalCommand } from "../tools/terminal.js";
import type { TuiDependencies, TuiModelRegistry } from "./types.js";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as { version?: unknown };

function packageVersion(): string {
  return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
}

export function createDefaultTuiDependencies(
  registry: TuiModelRegistry,
): TuiDependencies {
  return {
    registry,
    version: packageVersion(),
    workspacePath: process.cwd(),
    async listModels(baseUrl, apiKey, signal) {
      return listOfficialModelIds(createProviderClient(baseUrl, apiKey), signal);
    },
    createAgent(model: RegisteredModel, io: AgentIO) {
      return new ReactAgent({
        client: createProviderClient(
          model.base_url,
          model.api_key,
        ) as unknown as ResponsesClientLike,
        model: model.model_name,
        io,
      });
    },
    runBash(command) {
      return runBash(command);
    },
    runTerminalCommand(command) {
      return runTerminalCommand(command);
    },
  };
}
