import { render } from "ink";
import React from "react";
import { EverpeaceApp } from "./app.js";
import { createDefaultTuiDependencies } from "./dependencies.js";
import type { TuiDependencies, TuiModelRegistry } from "./types.js";

export interface RunTuiOptions {
  registry: TuiModelRegistry;
  dependencies?: TuiDependencies;
}

export const TUI_RENDER_OPTIONS = {
  exitOnCtrlC: false,
  alternateScreen: true,
} as const;

interface TerminalOutput {
  write(chunk: string): unknown;
}

export function clearTerminal(output: TerminalOutput = process.stdout): void {
  output.write("\u001B[2J\u001B[H");
}

export async function runTui({ registry, dependencies }: RunTuiOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Everpeace TUI requires an interactive terminal");
  }

  const resolvedDependencies =
    dependencies ?? createDefaultTuiDependencies(registry);
  const initialModels = await resolvedDependencies.registry.resolveAll();
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
}
