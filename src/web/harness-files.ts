import path from "node:path";
import { sensitivePath } from "../permissions/sensitive-access.js";
import { MAX_SKILL_DOCUMENT_BYTES } from "../skills/catalog.js";
import { decodeTextFile, sha256Bytes } from "../tools/file-version.js";
import { SafeFileError, safeListDirectory, safeReadFile } from "../tools/safe-files.js";
import { enumerateSafeFiles } from "../tools/secure-enumeration.js";
import { redactSecretsPreservingLayout } from "../util/redact-secrets.js";
import { plainRecord } from "./harness-preferences.js";
import { WebRequestError, type WebWorkbench } from "./workbench.js";

const maxBytes = 16 * 1024 * 1024;
const maxEntries = 500;
const excluded = new Set([".git", ".codex", ".everpeace"]);

export const workspaceFileEndpoints = new Set([
  "workspaceFiles/read", "workspaceFiles/readBytes", "workspaceFiles/stat", "workspaceFiles/list", "workspaceFiles/search",
]);

function limitedInteger(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new WebRequestError(400, "Invalid file page range", "gateway/bad-request");
  }
  return value;
}

function visiblePath(relative: string) {
  return !sensitivePath(relative) && !relative.split("/").some(part => excluded.has(part.toLowerCase()));
}

function fileError(status: number, code: string, message: string, targetPath: string) {
  return new WebRequestError(status, message, `workspace-file/${code}`, { path: targetPath });
}

export function workspaceRelativePath(workspace: string, input: unknown, baseFile?: unknown): string {
  if (typeof input !== "string" || input.includes("\0") || input.length > 4_096) {
    throw new WebRequestError(400, "Invalid workspace file path", "gateway/bad-request");
  }
  let base = workspace;
  if (baseFile !== undefined) {
    if (path.isAbsolute(input) || /^[a-z]:/iu.test(input)) {
      throw new WebRequestError(400, "A file resource path must be relative to its base file", "gateway/bad-request");
    }
    base = path.dirname(path.resolve(workspace, workspaceRelativePath(workspace, baseFile)));
  }
  const relative = path.relative(workspace, path.resolve(base, input)).split(path.sep).join("/");
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative) || relative.includes(":") || !visiblePath(relative)) {
    throw fileError(403, "outside-workspace", "The path is outside the readable workspace", input);
  }
  return relative;
}

export class HarnessFiles {
  constructor(readonly workbench: WebWorkbench) {}

  #workspace(sessionId: unknown): string {
    if (typeof sessionId !== "string") throw new WebRequestError(400, "Expected a workspace session");
    this.workbench.requireSession(sessionId);
    return this.workbench.workspace;
  }

  async #target(sessionId: string, workspace: string, target: unknown, baseFile: unknown, allowSkill: boolean, signal?: AbortSignal) {
    try { return { root: workspace, relative: workspaceRelativePath(workspace, target, baseFile), skill: false }; }
    catch (error) {
      if (!(error instanceof WebRequestError) || error.status !== 403 || !allowSkill || baseFile !== undefined ||
          typeof target !== "string" || !path.isAbsolute(target) || path.basename(target) !== "SKILL.md" || sensitivePath(target)) throw error;
      const key = (value: string) => process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value);
      const file = (await this.workbench.availableSkills(sessionId, signal)).find(item => key(item.path) === key(target));
      if (!file || sensitivePath(file.path) || file.path !== redactSecretsPreservingLayout(file.path)) throw error;
      return { root: file.directory, relative: "SKILL.md", skill: true };
    }
  }

  async #read(workspace: string, relative: string, signal?: AbortSignal, skill = false) {
    if (!relative) throw fileError(400, "not-regular-file", "Select a regular workspace file", relative);
    const result = await safeReadFile(workspace, relative, signal);
    if (!result.exists) throw fileError(404, "not-found", "Workspace file was not found", relative);
    const limit = skill ? MAX_SKILL_DOCUMENT_BYTES : maxBytes;
    if (result.bytes.length > limit) {
      throw new WebRequestError(413, "Workspace file exceeds the preview limit", "workspace-file/too-large", {
        path: relative, limit,
      });
    }
    let bytes = result.bytes;
    if (skill) {
      try { bytes = Buffer.from(redactSecretsPreservingLayout(decodeTextFile(bytes).text)); }
      catch { throw fileError(415, "not-text", "Skill document is not UTF-8 text", relative); }
    }
    return {
      stat: {
        absolutePath: path.resolve(workspace, relative), version: sha256Bytes(bytes), bytes: bytes.length,
      },
      bytes,
    };
  }

  async #list(workspace: string, relative: string, signal?: AbortSignal) {
    const entries = await safeListDirectory(workspace, relative || ".", signal);
    return entries.filter(entry => visiblePath(entry.name)).map(({ name, type }) => ({
      name, type: type === "directory" || type === "file" ? type : "other",
    }));
  }

  async #search(workspace: string, request: unknown, signal?: AbortSignal) {
    if (!plainRecord(request) || typeof request.query !== "string" || request.query.length > 512 || !request.query.trim() ||
        request.excludedPaths !== undefined && (!Array.isArray(request.excludedPaths) || request.excludedPaths.length > 100 ||
          !request.excludedPaths.every(item => typeof item === "string" && item.length <= 512))) {
      throw new WebRequestError(400, "Invalid workspace file search", "gateway/bad-request");
    }
    const query = request.query.trim().toLowerCase();
    const denies = new Set<string>(request.excludedPaths ?? []);
    const files = await enumerateSafeFiles(workspace, ".", signal, {
      respectIgnore: request.respectGitignore !== false,
      excluded: new Set([...excluded, "node_modules"]),
    });
    const matches = new Map<string, "file" | "directory">();
    const searchPath = query.includes("/");
    const matchesQuery = (entry: string) => (searchPath ? entry : path.posix.basename(entry)).toLowerCase().includes(query);
    for (const file of files.paths) {
      const parts = file.split("/");
      if (!visiblePath(file) || request.includeHidden !== true && parts.some(part => part.startsWith("."))) continue;
      const ancestors = parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("/"));
      if ([file, ...ancestors].some(item => denies.has(item) || denies.has(path.posix.basename(item)))) continue;
      if (matchesQuery(file)) matches.set(file, "file");
      for (const directory of ancestors) if (matchesQuery(directory)) matches.set(directory, "directory");
    }
    const ordered = [...matches].sort(([a], [b]) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    return {
      matches: ordered.slice(0, maxEntries).map(([relative, type]) => ({ path: relative, type })),
      truncated: matches.size > maxEntries,
      incomplete: files.incomplete,
    };
  }

  async references(sessionId: unknown, query: unknown, signal?: AbortSignal) {
    const workspace = this.#workspace(sessionId);
    if (typeof query !== "string" || query.length > 512) {
      throw new WebRequestError(400, "Invalid file reference query", "gateway/bad-request");
    }
    const normalized = query.replaceAll("\\", "/");
    const slash = normalized.lastIndexOf("/");
    if (normalized && slash < 0) {
      const { matches } = await this.#search(workspace, { query: normalized, includeHidden: normalized.startsWith(".") }, signal);
      return matches.slice(0, 50).map(({ path, type }) => ({ path, kind: type }));
    }
    try {
      const directory = workspaceRelativePath(workspace, normalized.slice(0, slash + 1));
      const fragment = normalized.slice(slash + 1).toLowerCase();
      const entries = await this.#list(workspace, directory, signal);
      return entries.flatMap(entry =>
        entry.type === "other" || entry.name === "node_modules" ||
          entry.name.startsWith(".") && !fragment.startsWith(".") || !entry.name.toLowerCase().includes(fragment)
          ? []
          : [{ path: directory ? `${directory}/${entry.name}` : entry.name, kind: entry.type }],
      ).slice(0, 50);
    } catch (error) {
      if (error instanceof SafeFileError || error instanceof WebRequestError && error.status === 403) return [];
      throw error;
    }
  }

  async call(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const workspace = this.#workspace(args.workspaceFileScopeId);
    const target = args.path;
    try {
      if (endpoint === "workspaceFiles/search") return await this.#search(workspace, args.request, signal);
      const binary = endpoint === "workspaceFiles/readBytes";
      const options = (binary ? args.options : args.range) ?? {};
      if (!plainRecord(options)) throw new WebRequestError(400, "Invalid file options", "gateway/bad-request");
      const { root, relative, skill } = await this.#target(args.workspaceFileScopeId as string, workspace, target, binary ? options.baseFile : undefined, endpoint !== "workspaceFiles/list", signal);
      if (endpoint === "workspaceFiles/list") {
        const entries = await this.#list(workspace, relative, signal);
        return { path: relative, entries: entries.slice(0, maxEntries), truncated: entries.length > maxEntries };
      }
      const { stat, bytes } = await this.#read(root, relative, signal, skill);
      if (endpoint === "workspaceFiles/stat") return stat;
      if (binary) {
        const range = options.range;
        if (range !== undefined && !plainRecord(range)) throw new WebRequestError(400, "Invalid byte range", "gateway/bad-request");
        const offset = limitedInteger(range?.offset, 0, 0, Number.MAX_SAFE_INTEGER - maxBytes);
        const length = limitedInteger(range?.length, maxBytes, 1, maxBytes);
        const chunk = bytes.subarray(offset, offset + length);
        return { ...stat, offset, base64: chunk.toString("base64"), eof: offset + chunk.length >= bytes.length };
      }
      const offset = limitedInteger(options.offset, 1, 1, Number.MAX_SAFE_INTEGER - 2_000);
      const limit = limitedInteger(options.limit, 1_000, 1, 2_000);
      let text: string;
      try { text = decodeTextFile(bytes).text; }
      catch { throw fileError(415, "not-text", "Workspace file is not UTF-8 text", relative); }
      const lines = text ? text.split(/\r?\n/u) : [];
      if (text.endsWith("\n")) lines.pop();
      const page = lines.slice(offset - 1, offset - 1 + limit);
      const body = redactSecretsPreservingLayout(page.join("\n"));
      if (Buffer.byteLength(body) > 1024 * 1024) {
        throw new WebRequestError(413, "Text page exceeds the preview limit", "workspace-file/too-large", {
          path: relative, limit: 1024 * 1024,
        });
      }
      return { ...stat, offset, text: body, lines: page.length, eof: offset - 1 + page.length >= lines.length };
    } catch (error) {
      if (error instanceof SafeFileError) throw fileError(
        error.code === "POLICY_DENIED" ? 403 : 503,
        error.code === "POLICY_DENIED" ? "outside-workspace" : "unavailable", error.message,
        typeof target === "string" ? target : "",
      );
      throw error;
    }
  }

  async watch(args: Record<string, unknown>, write: (frame: unknown) => void, signal?: AbortSignal): Promise<() => void> {
    const workspace = this.#workspace(args.workspaceFileScopeId);
    const sessionId = args.workspaceFileScopeId as string;
    const { root, relative, skill } = await this.#target(sessionId, workspace, args.path, undefined, true, signal);
    const absolutePath = path.resolve(root, relative);
    const controller = new AbortController();
    const lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let directory = true;
    const version = async () => {
      if (skill) {
        try {
          const current = await this.#target(sessionId, workspace, args.path, undefined, true, lifetime);
          return (await this.#read(current.root, current.relative, lifetime, current.skill)).stat.version;
        } catch (error) {
          if (error instanceof WebRequestError && (error.status === 403 || error.status === 404)) return undefined;
          throw error;
        }
      }
      if (directory) {
        try {
          const entries = await this.#list(workspace, relative, lifetime);
          return sha256Bytes(Buffer.from(JSON.stringify(entries)));
        } catch (error) {
          if (!(error instanceof SafeFileError) || !relative) throw error;
          directory = false;
        }
      }
      const result = await safeReadFile(workspace, relative, lifetime);
      return result.exists ? sha256Bytes(result.bytes) : undefined;
    };
    let previous = await version();
    lifetime.throwIfAborted();
    write({ kind: "ready" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (lifetime.aborted) return;
      try {
        const current = await version();
        if (!lifetime.aborted && current !== previous) {
          previous = current;
          const change = current === undefined ? { absolutePath, absent: true } : { absolutePath, version: current };
          write({ kind: "change", change });
        }
      } catch { /* A transient native read failure carries no updated file identity. */ }
      if (!lifetime.aborted) timer = setTimeout(() => void poll(), 1_500);
    };
    timer = setTimeout(() => void poll(), 1_500);
    return () => { controller.abort(); clearTimeout(timer); };
  }
}
