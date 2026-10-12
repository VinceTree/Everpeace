import type { ExecEvent, ExecModelRegistry, ExecOptions, ExecResult } from "../../exec/types.js";
import { runExec } from "../../exec/runtime.js";
import { CliArgumentError, resolveExecPrompt, type ExecCliOptions } from "../args.js";
import {
  ExecJsonlEmitter,
  sanitizeExecOutput,
  type ExecJsonlUsage,
  type ExecProgressEvent,
} from "../exec-output.js";
import { ExecPipeProcess, ExecOutputError, ExecStreamWriter, isExecOutputError } from "../exec-writer.js";
import type { Writable } from "node:stream";

const MAX_STDIN_PROMPT_BYTES = 8 * 1024 * 1024;

export interface ExecCommandHost {
  cwd(): string;
  stdinIsTTY: boolean;
  readStdin(signal: AbortSignal): Promise<string>;
  writeStdout(text: string, signal?: AbortSignal): void | Promise<void>;
  flushStdout?(): Promise<void>;
  writeStderr(text: string, signal?: AbortSignal): void | Promise<void>;
  onSignal(handler: (exitCode: 130 | 143) => void): () => void;
  onStdoutError(handler: (error: Error) => void): () => void;
  onStderrError?(handler: (error: Error) => void): () => void;
  disposeOutput?(): Promise<void>;
}

export interface ExecCommandDependencies {
  run?: typeof runExec;
  version?: string;
}

function isEpipe(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EPIPE");
}

function abortError(message: string, name: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function waitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => { signal.removeEventListener("abort", aborted); resolve(value); },
      (error) => { signal.removeEventListener("abort", aborted); reject(error); },
    );
  });
}

async function readProcessStdin(signal: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const interrupt = () => process.stdin.destroy();
  signal.throwIfAborted();
  signal.addEventListener("abort", interrupt, { once: true });
  try {
    for await (const raw of process.stdin) {
      signal.throwIfAborted();
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "utf8");
      bytes += chunk.byteLength;
      if (bytes > MAX_STDIN_PROMPT_BYTES) {
        throw new CliArgumentError(`Piped exec prompt exceeds ${MAX_STDIN_PROMPT_BYTES} bytes`);
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener("abort", interrupt);
  }
  signal.throwIfAborted();
  return Buffer.concat(chunks, bytes).toString("utf8");
}

export function createProcessExecCommandHost(options: { outputStallMs?: number } = {}): ExecCommandHost {
  const writerOptions = options.outputStallMs === undefined ? {} : { stallMs: options.outputStallMs };
  const pipeProcess = !process.stdout.isTTY || !process.stderr.isTTY ? new ExecPipeProcess() : undefined;
  const stdoutStream = pipeProcess && !process.stdout.isTTY ? pipeProcess.stream(1) : process.stdout;
  const stderrStream = pipeProcess && !process.stderr.isTTY ? pipeProcess.stream(2) : process.stderr;
  const stdout = new ExecStreamWriter(stdoutStream, writerOptions);
  const stderr = new ExecStreamWriter(stderrStream, writerOptions);
  let disposing = false;
  const failureHandlers = new Map<Writable, Set<(error: Error) => void>>();
  const write = async (writer: ExecStreamWriter, stream: Writable, text: string, signal?: AbortSignal) => {
    try { await writer.write(text, signal); }
    catch (error) {
      // Writable emits its error after _destroy completes. Cancel the task at the
      // failed write boundary, before runtime resource cleanup can finish.
      if (!disposing) for (const handler of failureHandlers.get(stream) ?? []) handler(error instanceof Error ? error : new ExecOutputError(String(error)));
      throw error;
    }
  };
  const watch = (stream: Writable, handler: (error: Error) => void) => {
    const handlers = failureHandlers.get(stream) ?? new Set<(error: Error) => void>();
    failureHandlers.set(stream, handlers);
    handlers.add(handler);
    const failed = (error: Error) => { if (!disposing) handler(error); };
    const closed = () => { if (!disposing) handler(new ExecOutputError("Exec output was closed")); };
    stream.on("error", failed);
    stream.on("close", closed);
    return () => { handlers.delete(handler); stream.off("error", failed); stream.off("close", closed); };
  };
  return {
    cwd: () => process.cwd(),
    stdinIsTTY: process.stdin.isTTY === true,
    readStdin: readProcessStdin,
    writeStdout: (text, signal) => write(stdout, stdoutStream, text, signal),
    writeStderr: (text, signal) => write(stderr, stderrStream, text, signal),
    onSignal(handler) {
      const interrupt = () => handler(130);
      const terminate = () => handler(143);
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", terminate);
      return () => {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
      };
    },
    onStdoutError: (handler) => watch(stdoutStream, handler),
    onStderrError: (handler) => watch(stderrStream, handler),
    ...(pipeProcess ? { async disposeOutput() { disposing = true; await pipeProcess.dispose(); } } : {}),
  };
}

function progressEvent(event: ExecEvent): ExecProgressEvent {
  switch (event.type) {
    case "performance_report": return { ...event };
    case "cost_estimated": return { ...event };
    case "team_updated": case "agent_updated": case "team_usage": case "agent_integrated":
    case "session_started":
      return { ...event };
    case "assistant_message":
      return { ...event };
    case "tool_started":
      return { ...event };
    case "tool_finished": {
      const allowed = new Set(["completed", "failed", "cancelled", "skipped"] as const);
      const status = allowed.has(event.status as "completed" | "failed" | "cancelled" | "skipped")
        ? event.status as "completed" | "failed" | "cancelled" | "skipped"
        : undefined;
      return { type: event.type, name: event.name, ...(event.callId ? { callId: event.callId } : {}), ...(status ? { status } : {}) };
    }
    case "workflow_updated":
      return { ...event };
    case "interaction_required":
      return { ...event };
  }
}

function jsonUsage(result: ExecResult): ExecJsonlUsage | undefined {
  const usage = result.usage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
  };
}

function humanProgress(event: ExecEvent): string | undefined {
  switch (event.type) {
    case "cost_estimated": return event.estimate.warning ? "Estimated cost warning threshold reached; in-flight billing may continue.\n" : undefined;
    case "session_started":
      return `Session ${event.sessionId} · ${event.modelName}${event.parentSessionId ? ` · continued from ${event.parentSessionId}` : ""}\n`;
    case "agent_updated": case "agent_integrated":
      return `Team ${event.agentId}: ${event.state} · ${event.role ?? "member"}\n`;
    case "tool_started":
      return `Tool: ${event.name}\n`;
    case "workflow_updated":
      return event.result
        ? `Workflow: ${event.phase} · ${event.result}\n`
        : `Workflow: ${event.phase}\n`;
    case "interaction_required":
      return `Interaction required: ${event.tool}\n`;
    default:
      return undefined;
  }
}

function finalHumanMessage(result: ExecResult): string {
  if (result.exitCode === 0) return `Host verification: ${result.workflowResult ?? result.status}\n`;
  if (result.exitCode === 3) return `Host verification: ${result.workflowResult ?? "unverified"}\n`;
  if (result.exitCode === 4) return `Execution stopped: ${result.stopReason ?? result.status}\n`;
  if (result.exitCode === 5) return `Interaction required: ${result.interaction?.tool ?? "host input"}\n`;
  return `Everpeace exec failed: ${result.error ?? result.status}\n`;
}

/** Execute one headless task and keep all process-specific I/O at the CLI edge. */
export async function runExecCommand(
  options: ExecCliOptions,
  registry: ExecModelRegistry | (() => Promise<ExecModelRegistry>),
  host: ExecCommandHost = createProcessExecCommandHost(),
  dependencies: ExecCommandDependencies = {},
): Promise<number> {
  const controller = new AbortController();
  let signalExitCode: 130 | 143 | undefined;
  let outputClosed = false;
  let runtimeOptions: ExecOptions | undefined;
  const removeSignalHandlers = host.onSignal((exitCode) => {
    signalExitCode = exitCode;
    if (runtimeOptions) runtimeOptions.signalExitCode = exitCode;
    controller.abort(abortError(exitCode === 130 ? "Interrupted by SIGINT" : "Terminated by SIGTERM", "ExecSignalError"));
  });
  const outputFailed = (error: Error) => {
    outputClosed = true;
    controller.abort(new ExecOutputError("Exec output failed or closed", { cause: error }));
  };
  const removeStdoutHandler = host.onStdoutError(outputFailed);
  const removeStderrHandler = host.onStderrError?.(outputFailed);

  let emitter: ExecJsonlEmitter | undefined;
  try {
    if (options.json) {
      emitter = new ExecJsonlEmitter({ schemaVersion: options.team ? 2 : 1, write: (chunk, signal) => host.writeStdout(chunk, signal) });
    }
    const stdinText = host.stdinIsTTY ? undefined : await host.readStdin(controller.signal);
    const prompt = resolveExecPrompt(options, { stdinIsTTY: host.stdinIsTTY, ...(stdinText === undefined ? {} : { stdinText }) });
    controller.signal.throwIfAborted();
    let resolvedRegistry: ExecModelRegistry;
    try {
      resolvedRegistry = typeof registry === "function"
        ? await waitWithSignal(Promise.resolve().then(registry), controller.signal)
        : registry;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliArgumentError(`Exec startup configuration failed: ${message}`);
    }
    controller.signal.throwIfAborted();
    runtimeOptions = {
      prompt,
      ...(options.team ? { team: options.team } : {}),
      workspacePath: options.directory ?? host.cwd(),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.resume === undefined ? {} : { resume: options.resume }),
      ...(options.plan === true ? { plan: true } : {}),
      ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
      ...(options.tokenBudget === undefined ? {} : { tokenBudget: options.tokenBudget }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      signal: controller.signal,
      ...(signalExitCode === undefined ? {} : { signalExitCode }),
      ...(dependencies.version === undefined ? {} : { version: dependencies.version }),
    };

    if (options.json) {
      runtimeOptions.onEvent = (event) => emitter!.emit(progressEvent(event), controller.signal);
    } else {
      runtimeOptions.onEvent = async (event) => {
        const line = humanProgress(event);
        if (line) await host.writeStderr(sanitizeExecOutput(line), controller.signal);
      };
    }

    const result = await (dependencies.run ?? runExec)(runtimeOptions, { registry: resolvedRegistry });
    if (outputClosed || emitter?.broken) return signalExitCode ?? 1;
    if (options.json) {
      const usage = jsonUsage(result);
      await emitter!.finish({
        type: "run_finished",
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        status: result.classification,
        usageComplete: result.usageComplete,
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
        ...(result.workflowResult ? { workflowResult: result.workflowResult } : {}),
        ...(usage ? { usage } : {}),
      });
      if (result.error) await host.writeStderr(sanitizeExecOutput(`${result.error}\n`));
    } else {
      if (result.assistantText && signalExitCode === undefined) await host.writeStdout(`${sanitizeExecOutput(result.assistantText, Number.MAX_SAFE_INTEGER)}\n`, controller.signal);
      await host.writeStderr(sanitizeExecOutput(finalHumanMessage(result)));
    }
    await host.flushStdout?.();
    if (outputClosed) return 1;
    return signalExitCode ?? result.exitCode;
  } catch (error) {
    if (outputClosed || isExecOutputError(error) || emitter?.broken) return signalExitCode ?? 1;
    if (signalExitCode !== undefined) {
      try {
        if (options.json && emitter && !emitter.finished) {
          await emitter.finish({
            type: "run_finished",
            status: "cancelled",
            usageComplete: true,
            stopReason: "aborted",
          });
        }
        await host.flushStdout?.();
      } catch (outputError) {
        if (outputClosed || isEpipe(outputError)) return 1;
        return 1;
      }
      return signalExitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    try {
      await host.writeStderr(`${sanitizeExecOutput(message)}\n`);
      if (options.json && emitter && !emitter.finished) {
        await emitter.finish({
          type: "run_finished",
          status: error instanceof CliArgumentError ? "configuration_error" : "runtime_error",
          usageComplete: true,
        });
      }
      await host.flushStdout?.();
    } catch (outputError) {
      if (outputClosed || isEpipe(outputError)) return 1;
      return 1;
    }
    return error instanceof CliArgumentError ? 2 : 1;
  } finally {
    await host.disposeOutput?.();
    removeStdoutHandler();
    removeStderrHandler?.();
    removeSignalHandlers();
  }
}
