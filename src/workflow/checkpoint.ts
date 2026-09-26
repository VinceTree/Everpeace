import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ApplyPatchOperation, ApplyPatchResult } from "../tools/apply-patch.js";

interface CheckpointFile {
  path: string;
  beforeExists: boolean;
  beforeContent: string;
  beforeSha256: string | null;
  afterSha256: string | null;
}

export interface UndoResult {
  status: "undone" | "conflict" | "unavailable" | "empty";
  restored: string[];
  conflicts: string[];
  error?: string;
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function assertSafePath(root: string, relativePath: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, target);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Checkpoint path is outside the current workspace: ${relativePath}`);
  }
  let current = resolvedRoot;
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Checkpoint path traverses a symbolic link: ${relativePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
}

async function readFile(root: string, relativePath: string): Promise<{ exists: boolean; content: string }> {
  await assertSafePath(root, relativePath);
  const target = path.resolve(root, relativePath);
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Checkpoint target is not a regular file: ${relativePath}`);
    return { exists: true, content: await fs.readFile(target, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, content: "" };
    throw error;
  }
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.resolve(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.everpeace-undo-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try { await fs.rename(temp, target); } catch (error) { await fs.rm(temp, { force: true }); throw error; }
}

/** In-memory only journal for the latest Agent turn. File contents never enter Session JSONL. */
export class TurnCheckpoint {
  readonly #root: string;
  readonly #files = new Map<string, CheckpointFile>();
  #available = true;

  constructor(root: string) {
    this.#root = root;
  }

  get available(): boolean { return this.#available && this.#files.size > 0; }
  get paths(): string[] { return [...this.#files.keys()]; }

  #key(relativePath: string): string {
    const normalized = path.normalize(relativePath);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  clear(): void {
    if (this.#files.size === 0) return;
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
      });
    }
  }

  async recordApplied(operations: readonly ApplyPatchOperation[], result: ApplyPatchResult): Promise<void> {
    if (result.status !== "applied") return;
    for (const operation of operations) {
      const key = this.#key(operation.path);
      const item = this.#files.get(key);
      if (!item) continue;
      const after = await readFile(this.#root, operation.path);
      item.afterSha256 = after.exists ? digest(after.content) : null;
    }
  }

  async undo(): Promise<UndoResult> {
    if (!this.#available) return { status: "unavailable", restored: [], conflicts: [] };
    if (this.#files.size === 0) return { status: "empty", restored: [], conflicts: [] };
    const restored: string[] = [];
    const conflicts: string[] = [];
    for (const item of this.#files.values()) {
      let current: { exists: boolean; content: string };
      try {
        current = await readFile(this.#root, item.path);
      } catch {
        conflicts.push(item.path);
        continue;
      }
      const currentSha = current.exists ? digest(current.content) : null;
      if (currentSha !== item.afterSha256) {
        conflicts.push(item.path);
        continue;
      }
      const target = path.resolve(this.#root, item.path);
      if (item.beforeSha256 === null && !item.beforeExists) await fs.rm(target, { force: true });
      else await writeFile(this.#root, item.path, item.beforeContent);
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
}
