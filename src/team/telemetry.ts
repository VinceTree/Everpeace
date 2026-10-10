import { createHash } from "node:crypto";
import type { LoopEvent } from "../agent/agent-loop.js";
/** Bounded observation only; never changes default scheduling or retains bodies. */
export class TeamTelemetry {
  readonly #calls = new Map<string, Set<string>>();
  readonly #failures = new Map<string, number>();
  duplicateReads = 0;
  repeatedFailures = 0;
  observe(agentId: string, event: LoopEvent): void {
    if (event.type !== "tool_finished") return;
    const key = createHash("sha256").update(`${event.call.name}\0${event.call.arguments}`).digest("hex");
    if (["read_file", "search_files", "glob_files", "project_map"].includes(event.call.name)) {
      const owners = this.#calls.get(key) ?? new Set<string>();
      if (owners.size && !owners.has(agentId)) this.duplicateReads++;
      owners.add(agentId); this.#calls.set(key, owners);
    }
    let failure = false;
    try { const value = JSON.parse(event.output) as { status?: string; error?: string; exit_code?: number }; failure = ["error", "denied", "rejected", "failed"].includes(value.status ?? "") || typeof value.error === "string" || typeof value.exit_code === "number" && value.exit_code !== 0; } catch { /* Not every output is structured. */ }
    if (failure) { const count = (this.#failures.get(key) ?? 0) + 1; this.#failures.set(key, count); if (count > 1) this.repeatedFailures++; }
    if (this.#calls.size > 1024) this.#calls.delete(this.#calls.keys().next().value!);
    if (this.#failures.size > 1024) this.#failures.delete(this.#failures.keys().next().value!);
  }
  snapshot() { return { duplicateReads: this.duplicateReads, repeatedFailures: this.repeatedFailures }; }
}
