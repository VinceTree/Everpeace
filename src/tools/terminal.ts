import { spawn as spawnPty } from "node-pty";
import xtermHeadless from "@xterm/headless";
import type { BashResult } from "./bash.js";
import { stopProcessTree } from "./process-cancel.js";
import { retainOutput } from "./command-record.js";

const MAX_CAPTURED_OUTPUT = 2 * 1024 * 1024;
const MAX_SCROLLBACK_LINES = 10_000;
const { Terminal } = xtermHeadless;

export const DISABLE_FOCUS_REPORTING = "\u001B[?1004l";
export const DISABLE_WIN32_INPUT_MODE = "\u001B[?9001l";

interface TerminalOutput {
  write(chunk: string): unknown;
}

export function resetTerminalModes(
  output: TerminalOutput = process.stdout,
  platform: NodeJS.Platform = process.platform,
): void {
  output.write(
    DISABLE_FOCUS_REPORTING
      + (platform === "win32" ? DISABLE_WIN32_INPUT_MODE : ""),
  );
}

export interface TerminalCommandOptions {
  onInputReady?(write: ((input: string) => void) | undefined): void;
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  shellPath?: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** Write the raw PTY stream directly to stdout. */
  streamOutput?: boolean;
  /** Receive terminal-rendered snapshots suitable for an Ink history view. */
  onOutput?(output: string): void;
}

export interface TerminalInvocation {
  executable: string;
  args: string[];
  shellName: "PowerShell" | "Bash";
}

/**
 * Direct `!` commands follow the native command-line experience: PowerShell
 * on Windows and Bash on Unix-like systems.
 */
export function resolveTerminalInvocation(
  command: string,
  options: TerminalCommandOptions = {},
): TerminalInvocation {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return {
      executable: options.shellPath ?? "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-Command", command],
      shellName: "PowerShell",
    };
  }

  return {
    executable: options.shellPath ?? "bash",
    args: ["-c", command],
    shellName: "Bash",
  };
}

export function runTerminalCommand(
  command: string,
  options: TerminalCommandOptions = {},
): Promise<BashResult> {
  const invocation = resolveTerminalInvocation(command, options);
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const streamOutput = options.streamOutput ?? true;
  const onOutput = options.onOutput;
  const columns = Math.max(1, stdout.columns ?? 80);
  const rows = Math.max(1, stdout.rows ?? 24);
  const previewTerminal = onOutput
    ? createHeadlessTerminal(columns, rows)
    : undefined;

  return new Promise((resolve) => {
    if (options.signal?.aborted) { previewTerminal?.dispose(); resolve({ stdout: "", stderr: "", exitCode: null, signal: null, cancelled: true }); return; }
    let captured = "";
    let truncated = false;
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    let lastPreview = "";

    const emitPreview = (force = false): string => {
      if (!previewTerminal || !onOutput) return "";
      if (previewTimer) {
        clearTimeout(previewTimer);
        previewTimer = undefined;
      }
      const retained = retainOutput(readTerminalOutput(previewTerminal));
      truncated ||= retained.truncated || previewTerminal.buffer.active.length >= MAX_SCROLLBACK_LINES;
      const rendered = retained.text;
      if (rendered && (force || rendered !== lastPreview)) {
        lastPreview = rendered;
        onOutput(rendered);
      }
      return rendered;
    };

    const schedulePreview = (): void => {
      if (!previewTerminal || previewTimer) return;
      previewTimer = setTimeout(() => emitPreview(), 32);
    };

    const finish = (exitCode: number): void => {
      const resolveWithOutput = (output: string): void => {
        const finalOutput = truncated
          ? `${output}\n[terminal output truncated; retained output only]`
          : output;
        if (onOutput && finalOutput && finalOutput !== lastPreview) {
          lastPreview = finalOutput;
          onOutput(finalOutput);
        }
        previewTerminal?.dispose();
        resolve({
          stdout: finalOutput,
          stderr: "",
          exitCode,
          signal: null,
          cancelled: options.signal?.aborted ?? false,
          truncated,
        });
      };

      if (previewTerminal) {
        // xterm queues writes. An empty write callback runs after every PTY
        // chunk has been parsed, so the last snapshot cannot race the result.
        previewTerminal.write("", () => resolveWithOutput(emitPreview(true)));
      } else {
        void renderTerminalOutput(captured, columns, rows).then(resolveWithOutput);
      }
    };

    let child;
    try {
      child = spawnPty(invocation.executable, invocation.args, {
        name: env.TERM ?? "xterm-256color",
        cols: columns,
        rows,
        cwd: options.cwd ?? process.cwd(),
        env,
        ...(platform === "win32" ? { useConpty: true } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (streamOutput) {
        process.stderr.write(`Failed to start ${invocation.shellName}: ${message}\n`);
      }
      previewTerminal?.dispose();
      resolve({ stdout: "", stderr: "", exitCode: null, signal: null, error: message });
      return;
    }

    const wasRaw = stdin.isRaw;
    const wasPaused = stdin.readableFlowing === false;
    const forwardInput = (data: string | Buffer): void => {
      const input = data.toString();
      if (!input.includes("\u0003") && !options.signal?.aborted) child.write(input);
    };
    options.onInputReady?.((input) => { if (!options.signal?.aborted) child.write(input); });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      child.write("\u0003");
      killTimer = setTimeout(() => {
        if (platform !== "win32") stopProcessTree(child.pid);
        child.kill();
      }, 500);
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();

    try {
      if (!options.onInputReady) {
        if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(true);
        stdin.resume();
        stdin.on("data", forwardInput);
      }
    } catch {
      // The command can still run when stdin cannot be switched to raw mode.
    }

    const dataSubscription = child.onData((data) => {
      if (previewTerminal) previewTerminal.write(data, schedulePreview);
      if (streamOutput) stdout.write(data);
      if (captured.length < MAX_CAPTURED_OUTPUT) {
        const remaining = MAX_CAPTURED_OUTPUT - captured.length;
        const accepted = data.slice(0, remaining);
        captured += accepted;
        if (data.length > remaining) truncated = true;
      } else {
        truncated = true;
      }
    });

    child.onExit(({ exitCode }) => {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", cancel);
      dataSubscription.dispose();
      stdin.off("data", forwardInput);
      options.onInputReady?.(undefined);
      try {
        if (!options.onInputReady && stdin.isTTY && typeof stdin.setRawMode === "function") {
          stdin.setRawMode(wasRaw ?? false);
        }
        if (!options.onInputReady && wasPaused) stdin.pause();
      } catch {
        // Ink reclaims stdin after terminal suspension even if restoration fails.
      }

      // Only a raw stream can change modes on the parent terminal. Captured
      // output is interpreted by the headless emulator instead.
      if (streamOutput) resetTerminalModes(stdout, platform);
      finish(exitCode);
    });
  });
}

function createHeadlessTerminal(columns: number, rows: number) {
  return new Terminal({
    cols: Math.max(2, columns),
    rows: Math.max(1, rows),
    scrollback: MAX_SCROLLBACK_LINES,
    allowProposedApi: true,
  });
}

function readTerminalOutput(terminal: InstanceType<typeof Terminal>): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }

  return lines
    .join("\n")
    .replace(/^(?:[ \t]*\n)+/u, "")
    .trimEnd();
}

/** Render a VT/ConPTY byte stream into plain text using terminal semantics. */
export function renderTerminalOutput(
  output: string,
  columns = 80,
  rows = 24,
): Promise<string> {
  const terminal = createHeadlessTerminal(columns, rows);

  return new Promise((resolve) => {
    terminal.write(output.replaceAll("\0", ""), () => {
      const rendered = readTerminalOutput(terminal);
      terminal.dispose();
      resolve(rendered);
    });
  });
}
