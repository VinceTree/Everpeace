import type { ContextCompactionResult } from "./react-agent.js";
import type { LoopEvent } from "./agent-loop.js";
import { repairToolContext } from "./repair-context.js";
import { projectConversationCheckpoints } from "./conversation-checkpoint.js";
import { normalizeTokenUsageSample, type TokenUsageSample } from "../status/model-status.js";
import { PersistenceError, persistState } from "../storage/persistence-error.js";
import { ResourceCleanupError } from "../util/resource-cleanup-error.js";
import { LoopStoppedError } from "./agent-loop.js";

export class ContextCompactionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = "ContextCompactionError"; }
}
export interface ContextCompactionHost {
  compact(input: Array<Record<string, unknown>>, observe: (usage: TokenUsageSample | null) => Promise<void>): Promise<{ output: Array<Record<string, unknown>>; usage?: unknown }>;
  isStaleRule(item: Record<string, unknown>): boolean;
  persist: ((items: readonly Record<string, unknown>[], automatic: boolean, usage: TokenUsageSample | null) => Promise<void>) | undefined;
  usage(usage: TokenUsageSample | null): Promise<void>;
  goalUsage(usage: TokenUsageSample | null): Promise<void>;
  event: ((event: LoopEvent) => void) | undefined;
}
/** Owns the durable context revision and compaction lifecycle, without tool state. */
export class AgentContextRuntime {
  history: Array<Record<string, unknown>> = [];
  revision = 0;
  lastCompactedRevision = -1;
  window: number | null = null;
  tokens: number | null = null;
  compacting = false;
  controller: AbortController | undefined;
  operation: Promise<ContextCompactionResult> | undefined;
  append(items: readonly Record<string, unknown>[]): void { this.history.push(...items); if (items.length) this.revision++; }
  async compact(automatic: boolean, host: ContextCompactionHost, signal?: AbortSignal): Promise<ContextCompactionResult> {
    if (this.compacting) throw new Error("Context compaction is already running");
    if (!this.history.length) throw new Error("There is no conversation context to compact");
    this.compacting = true; const started = performance.now();
    const attempts: Array<TokenUsageSample | null> = []; let persisted = 0;
    try {
      host.event?.({ type: "compaction_started", automatic }); signal?.throwIfAborted();
      const input = projectConversationCheckpoints(repairToolContext(this.history.filter((item) => !host.isStaleRule(item))));
      const response = await host.compact(input, async (usage) => { attempts.push(usage); await host.goalUsage(usage); });
      while (persisted < Math.max(0, attempts.length - 1)) await host.usage(attempts[persisted++]!);
      if (!Array.isArray(response.output) || !response.output.every((item) => item && typeof item === "object" && !Array.isArray(item))) throw new Error("The compaction response returned an invalid context window");
      const items = response.output.map((item) => ({ ...item })); const usage = normalizeTokenUsageSample(response.usage);
      signal?.throwIfAborted();
      await persistState("Compaction persistence failed", () => host.persist?.(items, automatic, usage));
      persisted = attempts.length; if (!host.persist) await host.usage(usage);
      this.history = items; this.lastCompactedRevision = this.revision; this.tokens = null;
      signal?.throwIfAborted(); host.event?.({ type: "compaction_completed", automatic, usage }); return { items, usage };
    } catch (error) {
      while (persisted < attempts.length) await host.usage(attempts[persisted++]!);
      if (signal?.aborted || error instanceof ContextCompactionError || error instanceof PersistenceError || error instanceof ResourceCleanupError || error instanceof LoopStoppedError) throw error;
      throw new ContextCompactionError(error instanceof Error ? error.message : String(error), { cause: error });
    } finally {
      this.compacting = false;
      host.event?.({ type: "timing_recorded", operation: "compaction", durationMs: performance.now() - started });
    }
  }
}
