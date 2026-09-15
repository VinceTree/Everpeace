import { render } from "ink";
import React from "react";
import { resetTerminalModes } from "../tools/terminal.js";
import { EverpeaceApp } from "./app.js";
import { createDefaultTuiDependencies } from "./dependencies.js";
import type { TuiDependencies, TuiModelRegistry } from "./types.js";

export interface RunTuiOptions {
  registry: TuiModelRegistry;
  dependencies?: TuiDependencies;
}

export const TUI_RENDER_OPTIONS = {
  exitOnCtrlC: false,
  alternateScreen: false,
  incrementalRendering: false,
  kittyKeyboard: { mode: "auto" },
} as const;

interface TerminalOutput {
  write(chunk: string): unknown;
}

interface ResizableTerminalOutput extends TerminalOutput {
  prependListener(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

export const TERMINAL_RESET_SEQUENCE = "\u001B[2J\u001B[3J\u001B[H";

export function clearTerminal(output: TerminalOutput = process.stdout): void {
  output.write(TERMINAL_RESET_SEQUENCE);
}

export function installResizeRecovery(
  output: ResizableTerminalOutput = process.stdout,
): () => void {
  const recover = () => clearTerminal(output);
  output.prependListener("resize", recover);
  return () => output.off("resize", recover);
}

export async function runTui({ registry, dependencies }: RunTuiOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Everpeace TUI requires an interactive terminal");
  }

  // Recover from a previous child process or interrupted session that left
  // terminal focus reporting enabled before Ink starts reading input.
  resetTerminalModes();

  const resolvedDependencies =
    dependencies ?? createDefaultTuiDependencies(registry);
  const initialModels = await resolvedDependencies.registry.resolveAll();
  const removeResizeRecovery = installResizeRecovery();

  try {
    let clearOutput: () => void = () => undefined;
    const instance = render(
      <EverpeaceApp
        dependencies={resolvedDependencies}
        initialModels={initialModels}
        onClearOutput={() => clearOutput()}
      />,
      TUI_RENDER_OPTIONS,
    );
    clearOutput = () => {
      instance.clear();
      clearTerminal();
    };

    const result = await instance.waitUntilExit();
    return typeof result === "number" ? result : 0;
  } finally {
    removeResizeRecovery();
    resetTerminalModes();
  }
}
