import { spawn as spawnPty } from "node-pty";
import xtermHeadless from "@xterm/headless";
import type { BashResult } from "./bash.js";

const MAX_CAPTURED_OUTPUT = 2 * 1024 * 1024;
const MAX_SCROLLBACK_LINES = 10_000;
const { Terminal } = xtermHeadless;

export interface TerminalCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  shellPath?: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
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
  const columns = Math.max(1, stdout.columns ?? 80);
  const rows = Math.max(1, stdout.rows ?? 24);

  return new Promise((resolve) => {
    let captured = "";
    let truncated = false;
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
      process.stderr.write(`Failed to start ${invocation.shellName}: ${message}\n`);
      resolve({ stdout: "", stderr: "", exitCode: null, signal: null, error: message });
      return;
    }

    const wasRaw = stdin.isRaw;
    const wasPaused = stdin.readableFlowing === false;
    const forwardInput = (data: string | Buffer): void => child.write(data);

    try {
      if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", forwardInput);
    } catch {
      // The command can still run when stdin cannot be switched to raw mode.
    }

    const dataSubscription = child.onData((data) => {
      stdout.write(data);
      if (captured.length < MAX_CAPTURED_OUTPUT) {
        const remaining = MAX_CAPTURED_OUTPUT - captured.length;
        captured += data.slice(0, remaining);
        if (data.length > remaining) truncated = true;
      } else {
        truncated = true;
      }
    });

    child.onExit(({ exitCode }) => {
      dataSubscription.dispose();
      stdin.off("data", forwardInput);
      try {
        if (stdin.isTTY && typeof stdin.setRawMode === "function") {
          stdin.setRawMode(wasRaw ?? false);
        }
        if (wasPaused) stdin.pause();
      } catch {
        // Ink reclaims stdin after terminal suspension even if restoration fails.
      }

      if (platform === "win32") {
        // PowerShell running under ConPTY enables Win32 input mode (DEC 9001).
        // Since its output is proxied into Ink's parent terminal, reset that
        // private mode before Ink resumes or normal keys arrive as CSI records.
        stdout.write("\u001B[?9001l");
      }

      void renderTerminalOutput(captured, columns, rows).then((output) => {
        resolve({
          stdout: truncated
            ? `${output}\n[terminal output truncated after ${MAX_CAPTURED_OUTPUT} characters]`
            : output,
          stderr: "",
          exitCode,
          signal: null,
        });
      });
    });
  });
}

/** Render a VT/ConPTY byte stream into plain text using terminal semantics. */
export function renderTerminalOutput(
  output: string,
  columns = 80,
  rows = 24,
): Promise<string> {
  const terminal = new Terminal({
    cols: Math.max(2, columns),
    rows: Math.max(1, rows),
    scrollback: MAX_SCROLLBACK_LINES,
    allowProposedApi: true,
  });

  return new Promise((resolve) => {
    terminal.write(output.replaceAll("\0", ""), () => {
      const buffer = terminal.buffer.active;
      const lines: string[] = [];
      for (let index = 0; index < buffer.length; index += 1) {
        lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
      }
      terminal.dispose();

      resolve(
        lines
          .join("\n")
          .replace(/^(?:[ \t]*\n)+/u, "")
          .trimEnd(),
      );
    });
  });
}
