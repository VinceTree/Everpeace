export type PreparationOutcome = "unsupported_platform" | "missing_toolchain" | "preparation_failed";
export class BenchmarkPreparationError extends Error {
  constructor(readonly outcome: PreparationOutcome, message: string) { super(message); this.name = "BenchmarkPreparationError"; }
}
