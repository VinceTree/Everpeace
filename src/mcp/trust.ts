import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { defaultPermissionPath } from "../permissions/policy.js";
import { SystemAuthStorage, type AuthStorage } from "../storage/auth-storage.js";
import { stableJson } from "./launch.js";
import { McpPermanentConnectionError } from "./errors.js";

export type McpTrustKind = "mcp_start" | "mcp_http";
export interface McpTrustIdentity { workspace: string; name: string; kind: McpTrustKind; fingerprint: string; revision: number; }
export interface McpTrustPreview extends McpTrustIdentity { summary: string; approved: boolean; }
export interface McpTrustStoreLike {
  evaluate(workspace: string, name: string, kind: McpTrustKind, material: unknown): Promise<McpTrustIdentity & { approved: boolean }>;
  grant(identity: McpTrustIdentity, signal?: AbortSignal, beforeCommit?: () => Promise<void>): Promise<void>;
  revoke(workspace: string, name: string): Promise<void>;
}
interface TrustFile { version: 1; revision: number; grants: Array<Omit<McpTrustIdentity, "revision">>; }
const queues = new Map<string, Promise<unknown>>();

export class McpTrustStore implements McpTrustStoreLike {
  readonly path: string;
  readonly #auth: AuthStorage;
  constructor(options: { path?: string; authStorage?: AuthStorage } = {}) {
    this.path = options.path ?? join(dirname(defaultPermissionPath()), "mcp-trust.json");
    this.#auth = options.authStorage ?? new SystemAuthStorage();
  }

  async evaluate(workspace: string, name: string, kind: McpTrustKind, material: unknown): Promise<McpTrustIdentity & { approved: boolean }> {
    return this.#locked(async () => {
      const file = await this.#read();
      const authRef = `mcp-trust-hmac-${createHash("sha256").update(this.path).digest("hex")}`;
      let key = await this.#auth.get(authRef);
      if (!key) {
        // A lost key cannot carry old authorizations into a new key generation.
        if (file.grants.length) throw new Error("MCP trust fingerprint key is unavailable");
        key = randomBytes(32).toString("hex");
        await this.#auth.set(authRef, key);
      }
      const fingerprint = createHmac("sha256", key).update(stableJson({ workspace, name, kind, material })).digest("hex");
      return { workspace, name, kind, fingerprint, revision: file.revision, approved: file.grants.some((grant) => grant.workspace === workspace && grant.name === name && grant.kind === kind && grant.fingerprint === fingerprint) };
    });
  }

  async grant(identity: McpTrustIdentity, signal?: AbortSignal, beforeCommit?: () => Promise<void>): Promise<void> {
    await this.#locked(async () => {
      signal?.throwIfAborted();
      const file = await this.#read();
      if (file.revision !== identity.revision) throw new McpPermanentConnectionError("MCP trust changed; review a new preview");
      file.grants = file.grants.filter((grant) => grant.workspace !== identity.workspace || grant.name !== identity.name);
      file.grants.push({ workspace: identity.workspace, name: identity.name, kind: identity.kind, fingerprint: identity.fingerprint });
      file.revision++;
      await beforeCommit?.();
      signal?.throwIfAborted();
      await this.#write(file, signal, beforeCommit);
    });
  }

  async revoke(workspace: string, name: string): Promise<void> {
    await this.#locked(async () => {
      const file = await this.#read();
      file.grants = file.grants.filter((grant) => grant.workspace !== workspace || grant.name !== name);
      file.revision++;
      await this.#write(file);
    });
  }

  async #read(): Promise<TrustFile> {
    try {
      const stat = await fs.lstat(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Invalid trust file");
      const file: unknown = JSON.parse(await fs.readFile(this.path, "utf8"));
      if (!file || typeof file !== "object") throw new Error("Invalid trust file");
      const value = file as TrustFile;
      if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.grants) || !value.grants.every((item) => item && typeof item.workspace === "string" && typeof item.name === "string" && ["mcp_start", "mcp_http"].includes(item.kind) && typeof item.fingerprint === "string" && /^[a-f0-9]{64}$/u.test(item.fingerprint))) throw new Error("Invalid trust file");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, revision: 0, grants: [] };
      throw error;
    }
  }

  async #write(file: TrustFile, signal?: AbortSignal, beforeCommit?: () => Promise<void>): Promise<void> {
    const temporary = `${this.path}.tmp-${randomUUID()}`;
    try {
      await fs.writeFile(temporary, JSON.stringify(file) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      for (let attempt = 0; ; attempt++) {
        await beforeCommit?.();
        signal?.throwIfAborted();
        try { await fs.rename(temporary, this.path); break; }
        catch (error) {
          if (process.platform !== "win32" || attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
        }
      }
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }

  async #locked<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.path) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      try {
        await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const release = await lockfile.lock(this.path, { realpath: false, stale: 60_000, update: 20_000, retries: { retries: 5, minTimeout: 20, maxTimeout: 100 } });
        try { return await operation(); } finally { await release(); }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (error instanceof McpPermanentConnectionError) throw error;
        throw new McpPermanentConnectionError("MCP trust storage is unavailable; startup is blocked");
      }
    });
    queues.set(this.path, current);
    try { return await current; } finally { if (queues.get(this.path) === current) queues.delete(this.path); }
  }
}
