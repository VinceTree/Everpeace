import { createHash } from "node:crypto";
import { safeReadFile, safeCommitFile } from "../tools/safe-files.js";
import { ResourceCleanupError } from "../util/resource-cleanup-error.js";
import path from "node:path";
import type { ApplyPatchOperation, ApplyPatchResult } from "../tools/apply-patch.js";

interface CheckpointFile {
  path: string;
  beforeExists: boolean;
  beforeContent: Buffer;
  beforeSha256: string | null;
  afterSha256: string | null;
  committed: boolean;
  beforeAttributes?: number;
  beforeIdentity: string | null;
  afterIdentity: string | null;
}

export interface UndoResult {
  status: "undone" | "conflict" | "unavailable" | "empty";
  restored: string[];
  conflicts: string[];
  error?: string;
}

export interface CheckpointReviewResult {
  passed: boolean;
  conflicts: string[];
  error?: string;
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readFile(root: string, relativePath: string): Promise<{ exists: boolean; content: Buffer; attributes?: number; identity?: string }> {
  const relative = path.relative(path.resolve(root), path.resolve(root, relativePath));
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('Checkpoint path is outside the current workspace');
  const value = await safeReadFile(root, relativePath);
  return { exists: value.exists, content: value.bytes, ...(value.attributes === undefined ? {} : { attributes: value.attributes }), ...(value.identity ? { identity: value.identity } : {}) };
}

/** In-memory only journal for the latest Agent turn. File contents never enter Session JSONL. */
export class TurnCheckpoint {
  readonly #root: string;
  readonly #files = new Map<string, CheckpointFile>();
  #available = true;

  constructor(root: string) {
    this.#root = root;
  }

  get available(): boolean { return this.#available && [...this.#files.values()].some(file => file.committed); }
  get paths(): string[] { return [...this.#files.keys()]; }

  #key(relativePath: string): string {
    const normalized = path.normalize(relativePath);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  clear(): void {
    this.#files.clear();
    this.#available = true;
  }

  async capture(operations: readonly ApplyPatchOperation[]): Promise<void> {
    for (const operation of operations) {
      const key = this.#key(operation.path);
      if (this.#files.has(key)) continue;
      const before = await readFile(this.#root, operation.path);
      this.#files.set(key, {
        path: operation.path,
        beforeExists: before.exists,
        beforeContent: before.content,
        beforeSha256: before.exists ? digest(before.content) : null,
        afterSha256: null,
        committed: false,
        ...(before.attributes === undefined ? {} : { beforeAttributes: before.attributes }),
        beforeIdentity: before.identity ?? null,
        afterIdentity: null,
      });
    }
  }

  async recordApplied(operations: readonly ApplyPatchOperation[], result: ApplyPatchResult): Promise<void> {
    if (result.status !== "applied") return;
    for (const operation of operations) {
      const key = this.#key(operation.path);
      const item = this.#files.get(key);
      if (!item) continue;
      const committed = result.files.find(file => this.#key(file.path) === key && file.status === 'applied');
      if (committed?.beforeSha256 !== (item.committed ? item.afterSha256 : item.beforeSha256) || committed.beforeFileIdentity !== (item.committed ? item.afterIdentity : item.beforeIdentity) || committed.afterSha256 === undefined || committed.afterFileIdentity === undefined) {
        this.#available = false;
        continue;
      }
      // The committed post-image is authoritative. A subsequent user save must
      // never become the version that undo is permitted to overwrite.
      item.afterSha256 = committed.afterSha256;
      item.committed = true;
      item.afterIdentity = committed.afterFileIdentity;
    }
  }

  async undo(): Promise<UndoResult> {
    if (!this.#available) return { status: "unavailable", restored: [], conflicts: [] };
    if (![...this.#files.values()].some(file => file.committed)) return { status: "empty", restored: [], conflicts: [] };
    const restored: string[] = [];
    const conflicts: string[] = [];
    for (const item of this.#files.values()) {
      if (!item.committed) continue;
      let current: { exists: boolean; content: Buffer; identity?: string };
      try {
        current = await readFile(this.#root, item.path);
      } catch (error) {
        if (error instanceof ResourceCleanupError) throw error;
        conflicts.push(item.path);
        continue;
      }
      const currentSha = current.exists ? digest(current.content) : null;
      if (currentSha !== item.afterSha256 || (current.identity ?? null) !== item.afterIdentity) {
        conflicts.push(item.path);
        continue;
      }
      try {
        await safeCommitFile(this.#root, item.path, current.exists ? current.content : undefined, item.beforeExists ? item.beforeContent : undefined, undefined, item.beforeAttributes, current.identity);
      } catch (error) { if (error instanceof ResourceCleanupError) throw error; conflicts.push(item.path); continue; }
      restored.push(item.path);
    }
    this.#available = false;
    return {
      status: conflicts.length > 0 ? "conflict" : "undone",
      restored,
      conflicts,
      ...(conflicts.length > 0 ? { error: "Some files changed after the Agent turn and were not overwritten." } : {}),
    };
  }

  async reviewCurrent(): Promise<CheckpointReviewResult> {
    const conflicts: string[] = [];
    for (const item of this.#files.values()) {
      if (!item.committed) continue;
      try {
        const current = await readFile(this.#root, item.path);
        const currentSha = current.exists ? digest(current.content) : null;
        if (currentSha !== item.afterSha256 || (current.identity ?? null) !== item.afterIdentity) conflicts.push(item.path);
      } catch (error) { if (error instanceof ResourceCleanupError) throw error; conflicts.push(item.path); }
    }
    return conflicts.length === 0
      ? { passed: true, conflicts: [] }
      : { passed: false, conflicts, error: `Files changed after their structured edit: ${conflicts.join(", ")}` };
  }
}
