import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { defaultSessionDirectory } from "./session-store.js";

export interface InputHistoryStore {
  load(): Promise<string[]>;
  append(value: string): Promise<void>;
  clear(): Promise<void>;
}

export class InputHistory implements InputHistoryStore {
  #pending: Promise<void> = Promise.resolve();
  constructor(readonly file = path.join(path.dirname(defaultSessionDirectory()), "input-history.json")) {}
  async load(): Promise<string[]> {
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.entries) || !data.entries.every((v: unknown) => typeof v === "string")) return [];
      return data.entries.slice(-1000);
    } catch { return []; }
  }
  async #update(value?: string): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const release = await lockfile.lock(this.file, { realpath: false, retries: { retries: 30, minTimeout: 20, maxTimeout: 100 } });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const entries = value === undefined ? [] : await this.load();
      if (value && entries.at(-1) !== value) entries.push(value);
      while (entries.length > 1000 || Buffer.byteLength(JSON.stringify(entries)) > 4 * 1024 * 1024) entries.shift();
      await fs.writeFile(temporary, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
      await fs.rename(temporary, this.file);
    } finally {
      await fs.rm(temporary, { force: true });
      await release();
    }
  }
  #enqueue(value?: string): Promise<void> {
    const next = this.#pending.then(() => this.#update(value));
    this.#pending = next.catch(() => undefined);
    return next;
  }
  append(value: string) { return this.#enqueue(value); }
  clear() { return this.#enqueue(); }
}
