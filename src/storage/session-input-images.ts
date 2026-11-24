import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isInputImageReference, type InputImageReference } from "../agent/input-images.js";

function assertBytes(ref: InputImageReference, bytes: Uint8Array): void {
  if (!isInputImageReference(ref) || bytes.length !== ref.bytes ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== ref.attachmentId) {
    throw new Error("Session image bytes do not match their reference");
  }
}

/** Image bodies belong to the session, independent of model context compaction. */
export class SessionInputImages {
  readonly #root: string;

  constructor(sessionDirectory: string) { this.#root = path.join(sessionDirectory, "input-images"); }

  async sessions(): Promise<string[]> {
    if (!await this.#directory(this.#root)) return [];
    const entries = await fs.readdir(this.#root, { withFileTypes: true });
    if (entries.some(entry => entry.isSymbolicLink())) throw new Error("Session image storage cannot contain symbolic links");
    return entries.filter(entry => entry.isDirectory() && /^[A-Za-z0-9_-]+$/u.test(entry.name)).map(entry => entry.name);
  }

  #sessionDirectory(sessionId: string): string {
    if (!/^[A-Za-z0-9_-]+$/u.test(sessionId)) throw new Error("Invalid session ID");
    return path.join(this.#root, sessionId);
  }

  #fileName(ref: InputImageReference): string {
    if (!isInputImageReference(ref)) throw new Error("Invalid session image reference");
    return `${ref.attachmentId.slice(7)}.webp`;
  }

  async #directory(directory: string, create = false): Promise<boolean> {
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const metadata = await fs.lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Session image storage must be an ordinary directory");
      return true;
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async write(sessionId: string, ref: InputImageReference, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    assertBytes(ref, bytes);
    const directory = this.#sessionDirectory(sessionId);
    await this.#directory(this.#root, true);
    await this.#directory(directory, true);
    const target = path.join(directory, this.#fileName(ref));
    try {
      await this.read(sessionId, ref, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    signal?.throwIfAborted();
    const temporary = path.join(directory, `.image-${randomUUID()}`);
    try {
      const file = await fs.open(temporary, "wx", 0o600);
      try { await file.writeFile(bytes); await file.sync(); }
      finally { await file.close(); }
      signal?.throwIfAborted();
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async read(sessionId: string, ref: InputImageReference, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    const directory = this.#sessionDirectory(sessionId);
    await this.#directory(this.#root);
    await this.#directory(directory);
    const target = path.join(directory, this.#fileName(ref));
    const observed = await fs.lstat(target);
    if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1 || observed.size !== ref.bytes) {
      throw new Error("Session image file identity is invalid");
    }
    const handle = await fs.open(target, "r");
    try {
      const current = await handle.stat();
      if (current.dev !== observed.dev || current.ino !== observed.ino || current.nlink !== 1 || current.size !== ref.bytes) {
        throw new Error("Session image changed before it was read");
      }
      const bytes = Buffer.alloc(ref.bytes);
      let offset = 0;
      while (offset < bytes.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) throw new Error("Session image changed during read");
        offset += bytesRead;
      }
      assertBytes(ref, bytes);
      return bytes;
    } finally { await handle.close(); }
  }

  async stageFork(sessionId: string, directory: string, refs: readonly InputImageReference[], signal?: AbortSignal): Promise<void> {
    await this.#directory(directory, true);
    for (const ref of refs) {
      const bytes = await this.read(sessionId, ref, signal);
      const file = await fs.open(path.join(directory, this.#fileName(ref)), "wx", 0o600);
      try { await file.writeFile(bytes); await file.sync(); }
      finally { await file.close(); }
    }
  }

  async publishFork(sessionId: string, directory: string): Promise<void> {
    await this.#directory(this.#root, true);
    await fs.rename(directory, this.#sessionDirectory(sessionId));
  }

  async deleteSession(sessionId: string): Promise<void> {
    const directory = this.#sessionDirectory(sessionId);
    if (await this.#directory(this.#root) && await this.#directory(directory)) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}
