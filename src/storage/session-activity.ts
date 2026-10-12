import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

export interface ActivityRecord { version: 1; state: "open" | "closed"; at: string }
export interface ActivityLease { (clean?: boolean): Promise<void>; assertValid(): void }
/** A process-held lease protects idle sessions as well as running requests. */
export class SessionActivity {
  readonly #leases = new Map<string, { refs: number; clean: boolean; pending: Promise<ActivityLease>; closing?: Promise<void> }>();
  readonly #retentions = new Map<string, Promise<void>>();
  constructor(readonly directory: string) {}
  #path(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(id)) throw new Error("Invalid Session identity");
    return path.join(this.directory, ".activity", `${id}.json`);
  }
  async #prepare(id: string): Promise<string> {
    const file = this.#path(id); const root = path.dirname(file);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(root)).isSymbolicLink()) throw new Error("Session activity directory must not be linked");
    try { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("Session activity marker must not be linked"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return file;
  }
  async #write(file: string, record: ActivityRecord): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  async acquire(id: string): Promise<ActivityLease> {
    let owned = this.#leases.get(id);
    if (owned?.closing) { await owned.closing; return this.acquire(id); }
    if (!owned) { owned = { refs: 0, clean: true, pending: this.#acquireOwned(id) }; this.#leases.set(id, owned); }
    owned.refs++;
    let lease: ActivityLease;
    try { lease = await owned.pending; lease.assertValid(); }
    catch (error) { owned.refs--; if (!owned.refs) this.#leases.delete(id); throw error; }
    let closed: Promise<void> | undefined;
    const shared: ActivityLease = (clean = true) => closed ??= (async () => {
      owned.clean &&= clean;
      if (--owned.refs === 0) {
        owned.closing = lease(owned.clean);
        try { await owned.closing; } finally { if (this.#leases.get(id) === owned) this.#leases.delete(id); }
      }
    })();
    shared.assertValid = () => { if (closed) throw new Error("Session activity ownership released"); lease.assertValid(); };
    return shared;
  }
  async #acquireOwned(id: string): Promise<ActivityLease> {
    const file = await this.#prepare(id);
    let compromised = false;
    const release = await lockfile.lock(file, { realpath: false, retries: 0, stale: 30_000, update: 10_000, onCompromised: () => { compromised = true; } });
    try { await this.#write(file, { version: 1, state: "open", at: new Date().toISOString() }); }
    catch (error) { await release(); throw error; }
    let operation: Promise<void> | undefined;
    const lease: ActivityLease = (clean = true) => operation ??= (async () => {
      try { if (clean && !compromised) await this.#write(file, { version: 1, state: "closed", at: new Date().toISOString() }); }
      finally { await release(); }
    })();
    lease.assertValid = () => { if (compromised || operation) throw new Error("Session activity ownership lost"); };
    return lease;
  }
  async inspect(id: string): Promise<"active" | "closed" | "unknown"> {
    const file = await this.#prepare(id);
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(file, { realpath: false, retries: 0 });
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return "unknown";
      const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      return value && typeof value === "object" && "version" in value && value.version === 1 && "state" in value && value.state === "closed" ? "closed" : "unknown";
    } catch (error) { return (error as NodeJS.ErrnoException).code === "ELOCKED" ? "active" : "unknown"; }
    finally { await release?.(); }
  }
  async hasRetainedTeam(id: string): Promise<boolean> {
    const file = await this.#prepare(id);
    try { const stat = await fs.lstat(`${file}.team`); return stat.isFile() || stat.isSymbolicLink(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async retainTeam(id: string): Promise<void> {
    let pending = this.#retentions.get(id);
    if (!pending) {
      pending = Promise.resolve().then(() => this.#retainTeamOwned(id));
      this.#retentions.set(id, pending);
    }
    try { await pending; }
    finally { if (this.#retentions.get(id) === pending) this.#retentions.delete(id); }
  }
  async #retainTeamOwned(id: string): Promise<void> {
    if (await this.hasRetainedTeam(id)) return;
    // First ownership is persisted before team publication. Automatic cleanup
    // holds this same lease, so it cannot race with acquiring membership.
    await this.withInactive(id, async () => {
      const file = await this.#prepare(id);
      try { await fs.writeFile(`${file}.team`, "retained\n", { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    });
  }
  async withInactive<T>(id: string, operation: () => Promise<T>, requireClosed = false): Promise<T> {
    const file = await this.#prepare(id);
    const release = await lockfile.lock(file, { realpath: false, retries: 0 });
    try {
      if (requireClosed) {
        if (await this.hasRetainedTeam(id)) throw new Error("Session has retained team ownership");
        const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
        if (!value || typeof value !== "object" || !("state" in value) || value.state !== "closed") throw new Error("Session activity state changed");
      }
      return await operation();
    } finally { await release(); }
  }
}
