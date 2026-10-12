import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { defaultRegistryPath } from "./model-registry.js";

/** User configuration only; project files never supply credentials or prices. */
export class UserSettingsStore<T> {
  readonly path: string;
  constructor(name: string, readonly validate: (value: unknown) => value is T, readonly empty: () => T, filePath?: string) {
    this.path = filePath ?? path.join(path.dirname(defaultRegistryPath()), name);
  }
  async read(): Promise<T> {
    try {
      const stat = await fs.lstat(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("Invalid user settings file");
      const value: unknown = JSON.parse(await fs.readFile(this.path, "utf8"));
      if (!this.validate(value)) throw new Error("Invalid user settings format");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.empty();
      throw new Error("User settings could not be read", { cause: error });
    }
  }
  async update(change: (current: T) => T | Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path, { realpath: false, retries: { retries: 8, minTimeout: 20, maxTimeout: 100 } });
    const temporary = `${this.path}.tmp-${randomUUID()}`;
    try {
      const next = await change(await this.read());
      if (!this.validate(next)) throw new Error("Invalid user settings update");
      await fs.writeFile(temporary, JSON.stringify(next) + "\n", { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, this.path);
      return next;
    } finally { await fs.rm(temporary, { force: true }); await release(); }
  }
}
