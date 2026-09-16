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

export const TERMINAL_RESET_SEQUENCE = "\u001B[2J\u001B[3J\u001B[H";
export const SYNCHRONIZED_OUTPUT_START = "\u001B[?2026h";
export const SYNCHRONIZED_OUTPUT_END = "\u001B[?2026l";

export function clearTerminal(output: TerminalOutput = process.stdout): void {
  output.write(TERMINAL_RESET_SEQUENCE);
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

  try {
    let replayOutput: (update: () => void) => void = (update) => update();
    const instance = render(
      <EverpeaceApp
        dependencies={resolvedDependencies}
        initialModels={initialModels}
        onReplayOutput={(update) => replayOutput(update)}
      />,
      TUI_RENDER_OPTIONS,
    );
    replayOutput = (update) => {
      // Keep the scrollback reset and the following synchronous Ink commit in
      // one terminal update. Windows Terminal therefore never exposes the
      // empty intermediate frame while a resize replay is taking place.
      process.stdout.write(SYNCHRONIZED_OUTPUT_START);
      instance.clear();
      clearTerminal();
      try {
        update();
      } catch (error) {
        process.stdout.write(SYNCHRONIZED_OUTPUT_END);
        throw error;
      }
      const finishSynchronizedOutput = () => {
        process.stdout.write(SYNCHRONIZED_OUTPUT_END);
      };
      void instance
        .waitUntilRenderFlush()
        .then(finishSynchronizedOutput, finishSynchronizedOutput);
    };

    const result = await instance.waitUntilExit();
    return typeof result === "number" ? result : 0;
  } finally {
    resetTerminalModes();
  }
}
