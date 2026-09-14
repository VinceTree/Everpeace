import {
  BASH_TOOL_DEFINITION,
  parseBashCommand,
  serializeBashResult,
  type BashResult,
} from "../tools/bash.js";

interface FunctionCallItem extends Record<string, unknown> {
  type: "function_call";
  name: string;
  arguments: string;
  call_id: string;
}

interface ResponseOutputItem extends Record<string, unknown> {
  type: string;
  name?: string;
  arguments?: string;
  call_id?: string;
}

interface AgentResponse {
  id: string;
  output_text: string;
  output: ResponseOutputItem[];
}

export interface ResponsesClientLike {
  responses: {
    create(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<AgentResponse>;
  };
}

export interface AgentIO {
  confirmBash(command: string): Promise<boolean>;
  runBash(command: string): Promise<BashResult>;
  writeAssistant(text: string): void;
}

export interface ReactAgentOptions {
  client: ResponsesClientLike;
  model: string;
  io: AgentIO;
}

const INSTRUCTIONS = `You are Everpeace, a concise coding agent.
You have one tool named bash. Use it whenever terminal access is needed.
Before calling bash, briefly tell the user what you are about to do.
Base your answer on actual tool results and never claim a command succeeded when it did not.
The user must approve every bash command you request.`;

function isFunctionCall(item: ResponseOutputItem): item is FunctionCallItem {
  return (
    item.type === "function_call" &&
    typeof item.name === "string" &&
    typeof item.arguments === "string" &&
    typeof item.call_id === "string"
  );
}

export class ReactAgent {
  readonly #client: ResponsesClientLike;
  readonly #model: string;
  readonly #io: AgentIO;
  #history: Array<Record<string, unknown>> = [];

  constructor(options: ReactAgentOptions) {
    this.#client = options.client;
    this.#model = options.model;
    this.#io = options.io;
  }

  async runTurn(userInput: string, signal?: AbortSignal): Promise<void> {
    const history: Array<Record<string, unknown>> = [
      ...this.#history,
      { role: "user", content: userInput },
    ];
    let response = await this.#createResponse(history, signal);

    while (true) {
      history.push(...response.output);

      if (response.output_text.trim()) {
        this.#io.writeAssistant(response.output_text.trim());
      }

      const calls = response.output.filter(isFunctionCall);
      if (calls.length === 0) {
        this.#history = history;
        return;
      }

      const outputs: Array<Record<string, unknown>> = [];

      for (const call of calls) {
        const command =
          call.name === BASH_TOOL_DEFINITION.name
            ? parseBashCommand(call.arguments)
            : undefined;
        let output: string;

        if (command === undefined) {
          output = JSON.stringify({
            error: `Invalid or unsupported tool call: ${call.name}`,
          });
        } else if (!(await this.#io.confirmBash(command))) {
          output = JSON.stringify({
            status: "rejected",
            message: "The user rejected this Bash command. Do not execute it.",
          });
        } else {
          output = serializeBashResult(await this.#io.runBash(command));
        }

        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output,
        });
      }

      history.push(...outputs);
      this.#history = [...history];
      response = await this.#createResponse(history, signal);
    }
  }

  async #createResponse(
    input: Array<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<AgentResponse> {
    return this.#client.responses.create(
      {
        model: this.#model,
        instructions: INSTRUCTIONS,
        input,
        tools: [BASH_TOOL_DEFINITION],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
        include: ["reasoning.encrypted_content"],
      },
      signal === undefined ? undefined : { signal },
    );
  }
}
