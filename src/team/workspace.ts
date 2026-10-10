import { observeProcessCompletion } from "../tools/process-completion.js";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { decodeTextFile, encodeTextFile, sha256Bytes } from "../tools/file-version.js";
import { isProtectedPatchPath } from "../tools/sandbox-policy.js";
import type { ApplyPatchOperation } from "../tools/apply-patch.js";

const MAX_FILES = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;
export interface TeamWorkspaceRecord { version: 1; source: string; workspace: string; owner: string; commonGitDir: string; baseline: Record<string, string | null>; }
export function within(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
export function teamWorkspaceRoot(): string { return path.join(os.tmpdir(), "everpeace-teams"); }
export function workspaceOwnershipFile(owner: string): string { if (!/^[a-f0-9-]{36}$/u.test(path.basename(owner)) || path.dirname(path.resolve(owner)) !== path.resolve(teamWorkspaceRoot())) throw new Error("Invalid workspace owner"); return path.join(teamWorkspaceRoot(), "records", `${path.basename(owner)}.json`); }
export async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const child = spawn("git", ["-c", "core.hooksPath=", "-c", "core.fsmonitor=false", "-c", "core.longpaths=true", ...args], { cwd, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GIT_LFS_SKIP_SMUDGE: "1" } });
  const owned = observeProcessCompletion(child, { ...(signal ? { signal } : {}), timeoutMs: 30_000 });
  let output = ""; let bytes = 0; let failure: Error | undefined;
  let warning = false;
  child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => { if (/warning:|error:/iu.test(chunk)) warning = true; });
  child.stdout!.on("data", (chunk: string) => { bytes += Buffer.byteLength(chunk); if (bytes > 2 * 1024 * 1024) { failure = new Error("Git output exceeded the snapshot limit"); owned.stop(); } else output += chunk; });
  const result = await owned.completion;
  if (result.cleanupError) throw result.cleanupError;
  signal?.throwIfAborted();
  if (failure) throw failure;
  if (warning && ["ls-files", "ls-tree"].includes(args[0] ?? "")) throw new Error("Git reported incomplete snapshot discovery; coding delegation was refused");
  if (result.error || result.timedOut || result.exitCode !== 0) throw new Error("Git operation failed; check repository and worktree availability");
  return output;
}

async function bytes(root: string, name: string): Promise<Buffer | null> {
  if (!name || path.isAbsolute(name) || name.includes(":") || name.includes("\0") || !within(root, path.join(root, name))) throw new Error("Unsafe team workspace path");
  let current = root;
  for (const part of name.split(/[\\/]/u)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Team snapshot cannot follow links: ${name}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  const stat = await fs.lstat(current);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error(`Team snapshot cannot capture this file: ${name}`);
  const content = await fs.readFile(current);
  const after = await fs.lstat(current);
  if (after.isSymbolicLink() || !after.isFile() || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino) throw new Error(`File changed while taking team snapshot: ${name}`);
  return content;
}
async function names(root: string, signal?: AbortSignal): Promise<string[]> {
  const listed = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], signal);
  const result = [...new Set(listed.split("\0").filter(Boolean))];
  if (result.length > MAX_FILES) throw new Error("Team snapshot has too many files");
  return result;
}
export async function createTeamWorkspace(sourcePath: string, signal?: AbortSignal, onOwned?: (record: TeamWorkspaceRecord) => Promise<void>): Promise<TeamWorkspaceRecord> {
  const source = await fs.realpath(sourcePath);
  const root = await fs.realpath((await git(source, ["rev-parse", "--show-toplevel"], signal)).trim());
  if (source !== root) throw new Error("Parallel coding currently requires the Git repository root as workspace");
  const head = (await git(source, ["rev-parse", "--verify", "HEAD"], signal)).trim();
  const entries = await git(source, ["ls-files", "--stage", "-z"], signal);
  if (entries.split("\0").some((entry) => entry.startsWith("160000 "))) throw new Error("Parallel coding cannot snapshot Git submodules");
  const commonGitDir = path.resolve(source, (await git(source, ["rev-parse", "--git-common-dir"], signal)).trim());
  const owner = path.join(teamWorkspaceRoot(), randomUUID());
  const workspace = path.join(owner, "w");
  const baseline: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  const contents = new Map<string, Buffer | null>();
  let total = 0;
  const headFiles = (await git(source, ["ls-tree", "-r", "--name-only", "-z", head], signal)).split("\0").filter(Boolean);
  const currentFiles = await names(source, signal);
  const listed = [...new Set([...headFiles, ...currentFiles])];
  if (listed.length > MAX_FILES) throw new Error("Team snapshot has too many files");
  for (const name of listed) {
    signal?.throwIfAborted();
    const content = await bytes(source, name);
    total += content?.length ?? 0;
    if (total > MAX_BYTES) throw new Error("Team snapshot exceeded its byte limit; narrow the project before parallel coding");
    contents.set(name, content); baseline[name] = content === null ? null : sha256Bytes(content);
  }
  // Recheck names and raw bytes; an incomplete or racing snapshot is never used.
  if (JSON.stringify(await names(source, signal)) !== JSON.stringify(currentFiles)) throw new Error("Workspace file list changed during snapshot");
  for (const [name] of contents) {
    const current = await bytes(source, name);
    if ((current === null ? null : sha256Bytes(current)) !== baseline[name]) throw new Error(`Workspace changed during snapshot: ${name}`);
  }
  if ((await git(source, ["rev-parse", "--verify", "HEAD"], signal)).trim() !== head) throw new Error("Git HEAD changed during snapshot");
  const record: TeamWorkspaceRecord = { version: 1, source, workspace, owner, commonGitDir, baseline };
  const ownershipText = JSON.stringify(record);
  if (Buffer.byteLength(ownershipText) > 2 * 1024 * 1024) throw new Error("Team snapshot metadata exceeded its byte limit");
  await fs.mkdir(path.join(teamWorkspaceRoot(), "records"), { recursive: true });
  for (const directory of [teamWorkspaceRoot(), path.join(teamWorkspaceRoot(), "records")]) if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("Team workspace storage must not follow links");
  await fs.mkdir(owner);
  await fs.writeFile(workspaceOwnershipFile(owner), ownershipText, { flag: "wx", mode: 0o600 });
  try {
    await onOwned?.(record);
    await git(source, ["worktree", "add", "--detach", "--no-checkout", workspace, head], signal);
    await git(workspace, ["read-tree", head], signal);
    for (const [name, content] of contents) {
      signal?.throwIfAborted();
      const target = path.join(workspace, name);
      if (content === null) await fs.rm(target, { force: true });
      else { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content); }
    }
    return record;
  } catch (error) {
    // Failed creation retains its ownership marker and any partial files for explicit cleanup.
    throw error;
  }
}
export async function loadTeamWorkspace(workspace: string, source: string, allowMissing = false): Promise<TeamWorkspaceRecord> {
  const owner = path.dirname(path.resolve(workspace));
  if (!within(teamWorkspaceRoot(), owner) || path.basename(workspace) !== "w") throw new Error("Unowned team workspace");
  for (const directory of [teamWorkspaceRoot(), path.join(teamWorkspaceRoot(), "records"), owner, workspace]) { try { const stat = await fs.lstat(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Team workspace ownership traverses a link"); } catch (error) { if (!(allowMissing && directory === workspace && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error; } }
  const marker = workspaceOwnershipFile(owner); const markerStat = await fs.lstat(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 2 * 1024 * 1024) throw new Error("Invalid workspace ownership record");
  const value = JSON.parse(await fs.readFile(marker, "utf8")) as TeamWorkspaceRecord;
  if (value.version !== 1 || value.owner !== owner || value.workspace !== workspace || value.source !== await fs.realpath(source) || !value.baseline || typeof value.baseline !== "object") throw new Error("Team workspace ownership mismatch");
  if (Array.isArray(value.baseline) || Object.entries(value.baseline).length > MAX_FILES || Object.entries(value.baseline).some(([name, hash]) => !name || path.isAbsolute(name) || name.includes(":") || name.includes("\0") || !within(workspace, path.join(workspace, name)) || hash !== null && (typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash)))) throw new Error("Invalid team baseline record");
  if (value.commonGitDir !== path.resolve(value.source, (await git(value.source, ["rev-parse", "--git-common-dir"])).trim())) throw new Error("Team Git ownership changed");
  return value;
}
function inScope(name: string, paths: string[]): boolean {
  const file = process.platform === "win32" ? name.toLowerCase() : name;
  return paths.some((path) => { const scope = (process.platform === "win32" ? path.toLowerCase() : path).replace(/\/$/u, ""); return scope === "." || file === scope || file.startsWith(`${scope}/`); });
}
export async function validateTeamResume(record: TeamWorkspaceRecord, scopes: string[]): Promise<string[]> {
  await loadTeamWorkspace(record.workspace, record.source);
  const conflicts: string[] = [];
  const candidates = new Set([...Object.keys(record.baseline), ...await names(record.source)]);
  for (const file of candidates) {
    if (!inScope(file, scopes)) continue;
    const current = await bytes(record.source, file); const child = await bytes(record.workspace, file);
    const hash = current === null ? null : sha256Bytes(current);
    if (hash !== (record.baseline[file] ?? null) && hash !== (child === null ? null : sha256Bytes(child))) conflicts.push(file);
  }
  return conflicts;
}
export async function workspaceOperations(record: TeamWorkspaceRecord, allowedPaths: string[], signal?: AbortSignal): Promise<{ operations: ApplyPatchOperation[]; conflicts: string[]; changedPaths: string[]; targetHashes: Record<string, string | null> }> {
  await loadTeamWorkspace(record.workspace, record.source);
  const operations: ApplyPatchOperation[] = []; const conflicts: string[] = []; const changedPaths: string[] = [];
  const targetHashes: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  const candidates = new Set([...Object.keys(record.baseline), ...await names(record.workspace, signal)]);
  for (const name of candidates) {
    signal?.throwIfAborted();
    const after = await bytes(record.workspace, name);
    const afterHash = after === null ? null : sha256Bytes(after);
    const beforeHash = record.baseline[name] ?? null;
    if (beforeHash === afterHash) continue;
    changedPaths.push(name); targetHashes[name] = afterHash;
    if (isProtectedPatchPath(name) || !inScope(name, allowedPaths)) { conflicts.push(name); continue; }
    const current = await bytes(record.source, name);
    const currentHash = current === null ? null : sha256Bytes(current);
    if (currentHash === afterHash) continue;
    if (currentHash !== beforeHash) { conflicts.push(name); continue; }
    if (after === null) { operations.push({ path: name, action: "delete", expectedSha256: beforeHash! }); continue; }
    const text = decodeTextFile(after);
    if (current !== null && !encodeTextFile(text.text, decodeTextFile(current)).equals(after)) { conflicts.push(name); continue; }
    operations.push({ path: name, action: current === null ? "create" : "update", content: current === null && text.hasBom ? `\ufeff${text.text}` : text.text, ...(beforeHash ? { expectedSha256: beforeHash } : {}) });
  }
  if (operations.length > 20 || operations.reduce((size, operation) => size + Buffer.byteLength(operation.content ?? ""), 0) > 512 * 1024) throw new Error("Member changes exceed apply_patch limits; delegate a smaller task");
  return { operations, conflicts, changedPaths, targetHashes };
}
export async function removeTeamWorkspace(record: TeamWorkspaceRecord): Promise<void> {
  await loadTeamWorkspace(record.workspace, record.source, true);
  const registered = (await git(record.source, ["worktree", "list", "--porcelain", "-z"])).split("\0").some((entry) => entry === `worktree ${record.workspace}`);
  if (registered) await git(record.source, ["worktree", "remove", "--force", record.workspace]);
  const owner = await fs.realpath(record.owner);
  const root = await fs.realpath(teamWorkspaceRoot());
  if (!within(root, owner) || owner === root) throw new Error("Unsafe team cleanup target");
  await fs.rm(owner, { recursive: true });
  await fs.unlink(workspaceOwnershipFile(record.owner));
}
