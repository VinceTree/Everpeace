import { setTimeout as delay } from "node:timers/promises";
import { LearnedMemoryRuntime, type LearnedTurn, type LearnedTurnOutcome } from "../memory/learned-memory.js";

/** The evaluator releases capture only after both workflow and external acceptance pass. */
export class EvaluationMemoryRuntime extends LearnedMemoryRuntime {
  #pending: LearnedTurn | undefined;

  override async finishTurn(turn: LearnedTurn, outcome: LearnedTurnOutcome): Promise<void> {
    if (outcome === "verified") this.#pending = turn;
  }

  async settleAccepted(accepted: boolean, signal: AbortSignal): Promise<void> {
    const turn = this.#pending;
    this.#pending = undefined;
    if (!turn || !accepted) return;
    await super.finishTurn(turn, "verified");
    const deadline = performance.now() + 120_000;
    while (true) {
      signal.throwIfAborted();
      const capture = (await this.status(turn.workspacePath)).capture;
      if (capture?.state === "failed") throw new Error("Memory capture failed; retain its ledger and stop the pilot");
      if (!capture?.queued && capture?.state !== "running") return;
      if (performance.now() >= deadline) throw new Error("Memory capture settlement timed out");
      await delay(25, undefined, { signal });
    }
  }
}
