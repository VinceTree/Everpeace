/** An owner with unconfirmed cleanup cannot admit more work or report success. */
export abstract class ResourceCleanupError extends Error {
  abstract readonly resource: "process" | "model_stream";
}
