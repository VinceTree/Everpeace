import type { ModelRegistry } from "../../storage/model-registry.js";
import { runTui } from "../../tui/index.js";

export async function runTuiCommand(registry: ModelRegistry): Promise<number> {
  return runTui({ registry });
}
