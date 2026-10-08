import { spawn, type ChildProcess } from "node:child_process";
import { Writable } from "node:stream";

export const EXEC_OUTPUT_CHUNK_BYTES = 16 * 1024;
export const EXEC_OUTPUT_BUFFER_BYTES = 1024 * 1024;
export const EXEC_OUTPUT_STALL_MS = 30_000;

export class ExecOutputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExecOutputError";
  }
}

export function isExecOutputError(error: unknown): boolean {
  return error instanceof ExecOutputError || Boolean(error && typeof error === "object"
    && ((error as { code?: unknown }).code === "EPIPE" || (error as { name?: unknown }).name === "ExecOutputError"));
}

const PIPE_WRITER_SOURCE = `
const streams = { 1: process.stdout, 2: process.stderr };
for (const stream of Object.values(streams)) stream.on('error', () => {});
process.on('message', message => {
  if (!message || (message.fd !== 1 && message.fd !== 2) || typeof message.text !== 'string') return;
  try {
    streams[message.fd].write(message.text, error => {
      if (process.connected) process.send({ id: message.id, ...(error ? { error: 'Output pipe failed' } : {}) }, () => {});
    });
  } catch (error) { process.send?.({ id: message.id, error: 'Output pipe failed' }); }
});
process.on('disconnect', () => process.exit(0));
`;

/** Owned non-TTY output keeps pending OS pipe writes out of the host process. */
export class ExecPipeProcess {
  #child: ChildProcess | undefined;
  #exit: Promise<void> | undefined;
  #stopped = false;
  #nextId = 0;
  readonly #pending = new Map<number, (error?: Error) => void>();
  readonly #streams = new Set<Writable>();
  #disposal: Promise<void> | undefined;

  stream(fd: 1 | 2): Writable {
    const stream = new Writable({
      write: (chunk: Buffer, _encoding, done) => { this.#write(fd, chunk.toString("utf8")).then(() => done(), done); },
      destroy: (error, done) => { void this.#stop().then(() => done(error), done); },
    });
    // A write callback may report an error after its caller has already cancelled.
    stream.on("error", () => {});
    this.#streams.add(stream);
    return stream;
  }

  async dispose(): Promise<void> {
    this.#disposal ??= (async () => {
      await this.#stop();
      await Promise.all([...this.#streams].map((stream) => new Promise<void>((resolve) => {
        if (stream.closed) { resolve(); return; }
        stream.once("close", resolve);
        stream.destroy();
      })));
    })();
    await this.#disposal;
  }

  async #stop(): Promise<void> {
    this.#stopped = true;
    for (const finish of this.#pending.values()) finish(new ExecOutputError("Exec output writer was closed"));
    this.#pending.clear();
    if (this.#child && this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill();
    await this.#exit;
  }

  #start(): ChildProcess {
    if (this.#stopped) throw new ExecOutputError("Exec output writer was closed");
    if (this.#child) return this.#child;
    const child = spawn(process.execPath, ["-e", PIPE_WRITER_SOURCE], {
      stdio: ["ignore", 1, 2, "ipc"], windowsHide: true,
    });
    this.#child = child;
    this.#exit = new Promise<void>((resolve) => {
      const failed = () => {
        this.#stopped = true;
        for (const finish of this.#pending.values()) finish(new ExecOutputError("Exec output writer stopped"));
        this.#pending.clear();
        resolve();
      };
      child.once("exit", failed);
      child.once("error", failed);
    });
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("id" in message)) return;
      const { id, error } = message as { id: number; error?: unknown };
      const finish = this.#pending.get(id);
      this.#pending.delete(id);
      finish?.(error === undefined ? undefined : new ExecOutputError("Exec output pipe failed"));
    });
    return child;
  }

  #write(fd: 1 | 2, text: string): Promise<void> {
    if (Buffer.byteLength(text) > EXEC_OUTPUT_CHUNK_BYTES || this.#pending.size >= 16) {
      return Promise.reject(new ExecOutputError("Exec output buffer exceeded 1 MiB"));
    }
    const child = this.#start();
    const id = ++this.#nextId;
    return new Promise<void>((resolve, reject) => {
      this.#pending.set(id, (error) => error ? reject(error) : resolve());
      child.send({ id, fd, text }, (error) => {
        if (!error) return;
        this.#pending.delete(id);
        reject(new ExecOutputError("Exec output writer failed", { cause: error }));
      });
    });
  }
}

/** Bounded Unicode chunks; callers retain the source text, never an encoded copy of the whole answer. */
export function* outputChunks(text: string, maximum = EXEC_OUTPUT_CHUNK_BYTES): Generator<string> {
  let start = 0;
  let size = 0;
  let index = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (size + bytes > maximum && index > start) {
      yield text.slice(start, index);
      start = index;
      size = 0;
    }
    size += bytes;
    index += character.length;
  }
  if (index > start) yield text.slice(start, index);
}

/** One awaited write at a time. No unbounded promise queue and no whole-frame buffering. */
export class ExecStreamWriter {
  readonly #stream: Writable;
  readonly #stallMs: number;
  #active = false;
  readonly #waiters: Array<() => void> = [];
  #failure: Error | undefined;

  constructor(stream: Writable, options: { stallMs?: number } = {}) {
    this.#stream = stream;
    this.#stallMs = options.stallMs ?? EXEC_OUTPUT_STALL_MS;
  }

  async write(text: string, signal?: AbortSignal): Promise<void> {
    if (this.#failure) throw this.#failure;
    if (this.#waiters.length >= 16) throw new ExecOutputError("Exec output queue exceeded 1 MiB");
    if (this.#active) await new Promise<void>((resolve) => this.#waiters.push(resolve));
    else this.#active = true;
    try {
      if (this.#failure) throw this.#failure;
      for (const chunk of outputChunks(text)) await this.#chunk(chunk, signal);
    } catch (error) {
      // Cancellation can abandon a partially written frame too; that stream is no longer usable.
      this.#failure = error instanceof Error ? error : new ExecOutputError(String(error));
      // A pending pipe write otherwise keeps Node alive after the task has already cleaned up.
      this.#stream.destroy();
      throw this.#failure;
    } finally {
      const next = this.#waiters.shift();
      if (next) next();
      else this.#active = false;
    }
  }

  #chunk(chunk: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.#stream.destroyed || this.#stream.writableEnded) return Promise.reject(new ExecOutputError("Exec output was closed"));
    if (this.#stream.writableLength + Buffer.byteLength(chunk) > EXEC_OUTPUT_BUFFER_BYTES) {
      return Promise.reject(new ExecOutputError("Exec output buffer exceeded 1 MiB"));
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let callbackDone = false;
      let drained = false;
      let writeReturned = false;
      const timer = setTimeout(() => finish(new ExecOutputError("Exec output made no progress for 30 seconds")), this.#stallMs);
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        this.#stream.off("error", failed);
        this.#stream.off("close", closed);
        this.#stream.off("drain", drain);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const complete = () => { if (writeReturned && callbackDone && drained) finish(); };
      const failed = (error: Error) => finish(new ExecOutputError("Exec output failed", { cause: error }));
      const closed = () => finish(new ExecOutputError("Exec output was closed"));
      const aborted = () => finish(signal?.reason ?? new ExecOutputError("Exec output was cancelled"));
      const drain = () => { drained = true; complete(); };
      this.#stream.once("error", failed);
      this.#stream.once("close", closed);
      this.#stream.once("drain", drain);
      signal?.addEventListener("abort", aborted, { once: true });
      try {
        drained = this.#stream.write(chunk, (error) => {
          if (error) { failed(error); return; }
          callbackDone = true;
          complete();
        });
        writeReturned = true;
        complete();
      } catch (error) {
        finish(new ExecOutputError("Exec output failed", { cause: error }));
      }
    });
  }
}
