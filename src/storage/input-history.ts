import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { sensitiveText } from "../permissions/sensitive-access.js";
import { defaultSessionDirectory } from "./session-store.js";

export interface InputHistoryEntry { text: string; sessionId: string | null; at: string | null; policy: "saved" | "legacy" }
export interface InputHistoryOptions { sessionId?: string; save?: boolean }
export interface InputHistoryStore {
  load(): Promise<string[]>;
  append(value: string, options?: InputHistoryOptions): Promise<void>;
  removeSessions?(ids: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

export class InputHistory implements InputHistoryStore {
  #pending: Promise<void> = Promise.resolve();
  constructor(readonly file = path.join(path.dirname(defaultSessionDirectory()), "input-history.json")) {}
  async entries(): Promise<InputHistoryEntry[]> {
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (data.version === 1 && Array.isArray(data.entries) && data.entries.every((v: unknown) => typeof v === 'string')) return data.entries.slice(-1000).filter((text: string) => !sensitiveText(text)).map((text: string) => ({ text, sessionId: null, at: null, policy: 'legacy' }));
      if (data.version !== 2 || !Array.isArray(data.entries) || !data.entries.every((v: InputHistoryEntry) => v && typeof v.text === 'string' && (v.sessionId === null || typeof v.sessionId === 'string') && (v.at === null || typeof v.at === 'string') && ['saved', 'legacy'].includes(v.policy))) return [];
      return data.entries.slice(-1000).filter((v: InputHistoryEntry) => !sensitiveText(v.text));
    } catch { return []; }
  }
  async load(): Promise<string[]> { return (await this.entries()).map(entry => entry.text); }
  async #update(value?: string, options?: InputHistoryOptions, remove?: readonly string[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const release = await lockfile.lock(this.file, { realpath: false, retries: { retries: 30, minTimeout: 20, maxTimeout: 100 } });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const entries = value === undefined && !remove ? [] : (await this.entries()).filter(entry => !remove || entry.sessionId === null || !remove.includes(entry.sessionId));
      if (value && (entries.at(-1)?.text !== value || entries.at(-1)?.sessionId !== (options?.sessionId ?? null))) entries.push({ text: value, sessionId: options?.sessionId ?? null, at: new Date().toISOString(), policy: "saved" });
      while (entries.length > 1000 || Buffer.byteLength(JSON.stringify(entries)) > 4 * 1024 * 1024) entries.shift();
      await fs.writeFile(temporary, JSON.stringify({ version: 2, entries }), { mode: 0o600 });
      await fs.rename(temporary, this.file);
    } finally {
      await fs.rm(temporary, { force: true });
      await release();
    }
  }
  #enqueue(value?: string, options?: InputHistoryOptions, remove?: readonly string[]): Promise<void> {
    const next = this.#pending.then(() => this.#update(value, options, remove));
    this.#pending = next.catch(() => undefined);
    return next;
  }
  append(value: string, options?: InputHistoryOptions) { return options?.save === false || sensitiveText(value) ? Promise.resolve() : this.#enqueue(value, options); }
  removeSessions(ids: readonly string[]) { return this.#enqueue(undefined, undefined, ids); }
  clear() { return this.#enqueue(); }
}
