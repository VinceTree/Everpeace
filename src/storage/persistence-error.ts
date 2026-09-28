/** Persistence failures must never be retried as model requests or tool errors. */
export class PersistenceError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`${operation}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "PersistenceError";
  }
}

export async function persistState<T>(operation: string, save: () => T | Promise<T>): Promise<T> {
  try {
    return await save();
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError(operation, error);
  }
}
