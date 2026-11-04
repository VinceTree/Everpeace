import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

export interface MemoryEpochs { global: number; user: number; project: number }
export interface MemoryControlState { schemaVersion: 1; global: number; user: number; projects: Record<string, number> }
export interface MemoryWrite { file: string; contents: string | null }
interface Transaction { state: MemoryControlState; writes: MemoryWrite[] }
const queues = new Map<string, Promise<unknown>>();
const initial = (): MemoryControlState => ({ schemaVersion: 1, global: 0, user: 0, projects: {} });
const validEpoch = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function validateState(value: unknown): MemoryControlState {
  if (!value || typeof value !== "object") throw new Error("Invalid Memory control file");
  const state = value as MemoryControlState;
  if (state.schemaVersion !== 1 || !validEpoch(state.global) || !validEpoch(state.user) || !state.projects || typeof state.projects !== "object" || Array.isArray(state.projects)
    || !Object.entries(state.projects).every(([key, epoch]) => /^[a-f0-9]{32}$/u.test(key) && validEpoch(epoch))) throw new Error("Invalid Memory control file");
  return state;
}
async function read(file: string): Promise<string | undefined> {
  try { return await fs.readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** All content mutations take this lock before any individual file lock. */
export class MemoryControl {
  readonly #directory: string;
  readonly #file: string;
  readonly #journal: string;
  constructor(directory: string) {
    this.#directory = path.resolve(directory);
    this.#file = path.join(this.#directory, "memory-control.json");
    this.#journal = path.join(this.#directory, "memory-transaction.json");
  }
  async run<T>(operation: (state: MemoryControlState) => Promise<T>): Promise<T> {
    const key = process.platform === "win32" ? this.#file.toLowerCase() : this.#file;
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const release = await lockfile.lock(this.#file, { realpath: false, stale: 60_000, update: 20_000, retries: { retries: 20, minTimeout: 10, maxTimeout: 100 } });
      try {
        const contents = await read(this.#file);
        let state = contents === undefined ? initial() : validateState(JSON.parse(contents));
        const pending = await read(this.#journal);
        if (pending !== undefined) {
          const transaction = JSON.parse(pending) as Transaction;
          state = validateState(transaction.state);
          this.#validateWrites(transaction.writes);
          await this.#apply({ state, writes: transaction.writes });
        }
        return await operation(state);
      } finally { await release(); }
    });
    queues.set(key, next);
    return next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
  }
  epochs(state: MemoryControlState, projectKey: string): MemoryEpochs {
    return { global: state.global, user: state.user, project: state.projects[projectKey] ?? 0 };
  }
  matches(state: MemoryControlState, projectKey: string, scope: "user" | "project", token?: MemoryEpochs): boolean {
    const current = this.epochs(state, projectKey);
    if (token === undefined) return current.global === 0 && current[scope] === 0;
    return validEpoch(token.global) && validEpoch(token[scope]) && token.global === current.global && token[scope] === current[scope];
  }
  /** The journal rename is the commit point. Recovery completes it before any reader. */
  async commit(state: MemoryControlState, writes: MemoryWrite[], beforeCommit?: () => void | Promise<void>): Promise<void> {
    validateState(state); this.#validateWrites(writes);
    const transaction = { state, writes };
    await this.#atomic(this.#journal, JSON.stringify(transaction) + "\n", beforeCommit);
    await this.#apply(transaction);
  }
  relative(file: string): string { return path.relative(this.#directory, file).replaceAll("\\", "/"); }
  #validateWrites(writes: MemoryWrite[]): void {
    if (!Array.isArray(writes) || !writes.every(write => write && typeof write.file === "string" && (write.contents === null || typeof write.contents === "string")
      && /^(?:learned\.md|memory-settings\.json|capture-jobs\.json|memory-candidates\.json|projects\/[a-f0-9]{32}\/(?:learned\.md|facts\.json))$/u.test(write.file))) throw new Error("Invalid Memory transaction");
  }
  async #apply(transaction: Transaction): Promise<void> {
    await this.#atomic(this.#file, JSON.stringify(transaction.state) + "\n");
    for (const write of transaction.writes) {
      const target = path.join(this.#directory, write.file);
      if (write.contents === null) await fs.rm(target, { force: true });
      else { await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await this.#atomic(target, write.contents); }
    }
    await fs.rm(this.#journal, { force: true });
  }
  async #atomic(file: string, contents: string, beforeCommit?: () => void | Promise<void>): Promise<void> {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        await beforeCommit?.();
        try { await fs.rename(temporary, file); break; }
        catch (error) {
          if (process.platform !== "win32" || attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await new Promise<void>(done => setTimeout(done, 10 * 2 ** attempt));
        }
      }
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  }
}
