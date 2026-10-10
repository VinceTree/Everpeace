import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { unzip } from "fflate";
import { parseSkillMetadata, type SkillMetadata, type SkillSnapshot, SkillCatalog } from "./catalog.js";
import { observeProcessCompletion, ProcessCleanupError } from "../tools/process-completion.js";
import { publicLookup, type FetchLike, type HostLookup } from "../network/public-address.js";
import { withPublicResponse } from "../network/public-http.js";
import { createPublicGitRelay, publicGitEnvironment } from "../network/git-relay.js";

const DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
const EXTRACTED_LIMIT_BYTES = 50 * 1024 * 1024;
const FILE_LIMIT_BYTES = 10 * 1024 * 1024;
const SKILL_FILE_LIMIT_BYTES = 512 * 1024;
const ARCHIVE_ENTRY_LIMIT = 10_000;
const SOURCE_ENTRY_LIMIT = 10_000;
const SKILL_ENTRY_LIMIT = 5_000;
const GIT_TREE_ENTRY_LIMIT = 20_000;
const GIT_TREE_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const GIT_MANIFEST_LIMIT = 500;
const GIT_CANDIDATE_LIMIT = 100;
const REDIRECT_LIMIT = 5;
const NETWORK_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 60_000;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface GitTreeEntry {
  mode: string;
  type: string;
  size: number | undefined;
  path: string;
}

export interface GitSkillCandidate {
  directory: string;
  name: string;
}

export type SkillTargetScope = "project" | "user";

export interface ManagedSkill extends SkillMetadata {
  conflict: boolean;
  usable: boolean;
  skillMarkdown: string;
  managed?: boolean;
  sourceUrl?: string;
}

export interface SkillInstallCandidate {
  id: string;
  name: string;
  description: string;
  skillMarkdown: string;
  files: readonly string[];
}

export interface PreparedSkillInstall {
  id: string;
  sourceUrl: string;
  candidates: readonly SkillInstallCandidate[];
}

export interface SkillInstallResult {
  name: string;
  directory: string;
  scope: SkillTargetScope;
}

export interface SkillLifecyclePreview { id: string; name: string; directory: string; sourceUrl?: string; action: "update" | "uninstall"; diff: string; changedFiles: string[]; }
interface ManagedSkillRecord { version: 1; name: string; scope: SkillTargetScope; sourceUrl?: string; hashes: Record<string, string>; }
export interface SkillManagerLike {
  previewUpdate?(directory: string, signal?: AbortSignal): Promise<SkillLifecyclePreview>;
  previewUninstall?(directory: string): Promise<SkillLifecyclePreview>;
  commitLifecycle?(id: string): Promise<void>;
  list(): Promise<readonly ManagedSkill[]>;
  saveCreated(skillMarkdown: string, scope: SkillTargetScope): Promise<SkillInstallResult>;
  prepareInstall(url: string, signal?: AbortSignal): Promise<PreparedSkillInstall>;
  installPrepared(preparationId: string, candidateId: string, scope: SkillTargetScope): Promise<SkillInstallResult>;
  discardPrepared(preparationId: string): Promise<void>;
}

interface CandidateRecord extends SkillInstallCandidate {
  sourceDirectory: string;
}

interface PreparationRecord {
  id: string;
  sourceUrl: string;
  temporaryDirectory: string;
  candidates: CandidateRecord[];
}

export interface SkillManagerOptions {
  workspacePath: string;
  catalog: SkillCatalog;
  fetch?: FetchLike;
  lookup?: HostLookup;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertSkillName(name: string): void {
  if ([...name].length > 64 || !SKILL_NAME_PATTERN.test(name)) {
    throw new Error("Skill name must use lowercase letters, numbers, and hyphens, with at most 64 characters");
  }
}

export function normalizeGeneratedSkillMarkdown(value: string): string {
  let normalized = value.replace(/^\uFEFF/u, "").trim();
  const fenced = normalized.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/iu);
  if (fenced?.[1]) normalized = fenced[1].trim();
  return `${normalized}\n`;
}

export function validateManagedSkillMarkdown(contents: string, path = "SKILL.md"): SkillMetadata {
  if (Buffer.byteLength(contents, "utf8") > SKILL_FILE_LIMIT_BYTES) {
    throw new Error(`SKILL.md exceeds ${SKILL_FILE_LIMIT_BYTES} bytes`);
  }
  const metadata = parseSkillMetadata(contents, path, "user");
  assertSkillName(metadata.name);
  return metadata;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function findProjectRoot(workspacePath: string): Promise<string> {
  let current = resolve(workspacePath);
  while (true) {
    if (await exists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(workspacePath);
    current = parent;
  }
}

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function safeArchivePath(name: string): string {
  const normalized = name.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error(`Archive contains an invalid path: ${name}`);
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Archive path escapes its root: ${name}`);
  }
  return segments.join("/");
}

async function readLimitedBytes(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > DOWNLOAD_LIMIT_BYTES) {
    throw new Error(`Skill download exceeds ${DOWNLOAD_LIMIT_BYTES} bytes`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DOWNLOAD_LIMIT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Skill download exceeds ${DOWNLOAD_LIMIT_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function unzipInto(data: Uint8Array, target: string): Promise<void> {
  const files = await new Promise<Record<string, Uint8Array>>((resolveFiles, reject) => {
    let entries = 0;
    let total = 0;
    unzip(data, {
      filter(info) {
        entries += 1;
        if (entries > ARCHIVE_ENTRY_LIMIT) throw new Error(`Skill archive exceeds ${ARCHIVE_ENTRY_LIMIT} entries`);
        if (info.originalSize > FILE_LIMIT_BYTES) throw new Error(`Archive file exceeds ${FILE_LIMIT_BYTES} bytes: ${info.name}`);
        total += info.originalSize;
        if (total > EXTRACTED_LIMIT_BYTES) throw new Error(`Skill archive exceeds ${EXTRACTED_LIMIT_BYTES} extracted bytes`);
        safeArchivePath(info.name);
        return !info.name.endsWith("/");
      },
    }, (error, output) => error ? reject(error) : resolveFiles(output));
  });
  for (const [rawName, contents] of Object.entries(files)) {
    const name = safeArchivePath(rawName);
    const path = resolve(target, ...name.split("/"));
    const relation = relative(target, path);
    if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`Archive path escapes its root: ${rawName}`);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, contents, { flag: "wx" });
  }
}

async function validateSkillDirectory(directory: string): Promise<{ metadata: SkillMetadata; markdown: string; files: string[] }> {
  const root = await fs.realpath(directory);
  const skillPath = join(root, "SKILL.md");
  const markdown = await fs.readFile(skillPath, "utf8").catch(() => {
    throw new Error(`SKILL.md not found in ${directory}`);
  });
  const metadata = validateManagedSkillMarkdown(markdown, skillPath);
  const files: string[] = [];
  const queue = [root];
  let count = 0;
  let total = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      count += 1;
      if (count > SKILL_ENTRY_LIMIT) throw new Error(`Skill contains more than ${SKILL_ENTRY_LIMIT} entries`);
      const path = join(current, entry.name);
      const stats = await fs.lstat(path);
      if (stats.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in installed skills: ${relative(root, path)}`);
      if (stats.isDirectory()) {
        queue.push(path);
        continue;
      }
      if (!stats.isFile()) throw new Error(`Unsupported file type in skill: ${relative(root, path)}`);
      if (stats.size > FILE_LIMIT_BYTES) throw new Error(`Skill file exceeds ${FILE_LIMIT_BYTES} bytes: ${relative(root, path)}`);
      total += stats.size;
      if (total > EXTRACTED_LIMIT_BYTES) throw new Error(`Skill exceeds ${EXTRACTED_LIMIT_BYTES} bytes`);
      files.push(relative(root, path).split(sep).join("/"));
    }
  }
  files.sort();
  return { metadata, markdown, files };
}

async function discoverCandidates(root: string): Promise<CandidateRecord[]> {
  const candidates: CandidateRecord[] = [];
  const queue = [root];
  let entries = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = await fs.readdir(current, { withFileTypes: true });
    entries += children.length;
    if (entries > SOURCE_ENTRY_LIMIT) throw new Error(`Skill source contains more than ${SOURCE_ENTRY_LIMIT} entries`);
    if (children.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      const validated = await validateSkillDirectory(current);
      candidates.push({
        id: String(candidates.length),
        name: validated.metadata.name,
        description: validated.metadata.description,
        skillMarkdown: validated.markdown,
        files: validated.files,
        sourceDirectory: current,
      });
      continue;
    }
    for (const entry of children) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "__MACOSX") continue;
      const path = join(current, entry.name);
      const stats = await fs.lstat(path);
      if (stats.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in skill sources: ${relative(root, path)}`);
      if (stats.isDirectory()) queue.push(path);
    }
  }
  if (candidates.length === 0) throw new Error("No valid SKILL.md was found at this source");
  return candidates;
}

async function copySkillTree(source: string, target: string): Promise<void> {
  await fs.mkdir(target, { recursive: false });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    const stats = await fs.lstat(sourcePath);
    if (stats.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${entry.name}`);
    if (stats.isDirectory()) await copySkillTree(sourcePath, targetPath);
    else if (stats.isFile()) await fs.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    else throw new Error(`Unsupported file type: ${entry.name}`);
  }
}

function parseGitHubSource(url: URL): { owner: string; repository: string; ref?: string; subpath?: string } | undefined {
  if (url.hostname.toLowerCase() !== "github.com") return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const owner = parts[0]!;
  const repository = parts[1]!.replace(/\.git$/u, "");
  if (parts[2] === "tree" && parts[3]) {
    let ref: string;
    let subpath: string;
    try {
      ref = decodeURIComponent(parts[3]);
      subpath = parts.slice(4).map((part) => decodeURIComponent(part)).join("/");
    } catch {
      throw new Error("GitHub Skill URL contains invalid percent encoding");
    }
    if (!ref || ref.includes("\\") || ref.includes("\0")) throw new Error("GitHub Skill URL contains an invalid ref");
    if (subpath) validateRepositoryPath(subpath, "GitHub Skill path");
    return { owner, repository, ref, ...(subpath ? { subpath } : {}) };
  }
  return { owner, repository };
}

function validateRepositoryPath(value: string, label: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`${label} is invalid: ${value}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} is invalid: ${value}`);
  }
  return segments.join("/");
}

function gitSecurityArguments(): string[] {
  return [
    "-c", "core.longpaths=true",
    "-c", "http.followRedirects=false",
    "-c", "credential.helper=",
    "-c", "http.extraHeader=",
    "-c", "http.cookieFile=",
    "-c", "http.sslVerify=true",
    "-c", "http.proxyAuthMethod=basic",
    "-c", "init.templateDir=",
    "-c", "core.hooksPath=",
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
  ];
}

export function buildGitCloneArguments(url: URL, target: string, ref?: string): string[] {
  return [
    ...gitSecurityArguments(),
    "clone", "--depth", "1", "--single-branch", "--no-checkout",
    ...(ref ? ["--branch", ref] : []),
    "--", url.toString(), target,
  ];
}

function buildGitRepositoryArguments(target: string, ...args: string[]): string[] {
  return [...gitSecurityArguments(), "-C", target, ...args];
}

export function parseGitTreeEntries(output: string): GitTreeEntry[] {
  const entries: GitTreeEntry[] = [];
  for (const record of output.split("\0")) {
    if (!record) continue;
    if (entries.length >= GIT_TREE_ENTRY_LIMIT) {
      throw new Error(`Git Skill source contains more than ${GIT_TREE_ENTRY_LIMIT} tracked entries`);
    }
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("Git Skill source returned an invalid tree entry");
    const header = record.slice(0, separator);
    const path = validateRepositoryPath(record.slice(separator + 1), "Git tree path");
    const match = header.match(/^([0-7]{6}) (\S+) ([0-9a-f]+)\s+(-|\d+)$/iu);
    if (!match) throw new Error(`Git Skill source returned an invalid tree entry for ${path}`);
    entries.push({
      mode: match[1]!,
      type: match[2]!,
      size: match[4] === "-" ? undefined : Number(match[4]),
      path,
    });
  }
  return entries;
}

function isWithinGitDirectory(path: string, directory: string): boolean {
  return directory === "." || path.startsWith(`${directory}/`);
}

function gitCandidatePreference(candidate: GitSkillCandidate): readonly [number, number, string] {
  const canonical = `skills/${candidate.name}`;
  const score = candidate.directory === canonical
    ? 0
    : candidate.directory === candidate.name
      ? 1
      : candidate.directory.endsWith(`/${canonical}`)
        ? 2
        : posix.basename(candidate.directory) === candidate.name
          ? 3
          : 4;
  return [score, candidate.directory.split("/").length, candidate.directory];
}

function compareGitCandidates(left: GitSkillCandidate, right: GitSkillCandidate): number {
  const a = gitCandidatePreference(left);
  const b = gitCandidatePreference(right);
  return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]);
}

export function selectGitSkillCandidates(candidates: readonly GitSkillCandidate[]): GitSkillCandidate[] {
  const selected = [...candidates]
    .sort(compareGitCandidates)
    .filter((candidate, index, all) => all.findIndex((item) => item.name === candidate.name) === index);
  if (selected.length > GIT_CANDIDATE_LIMIT) {
    throw new Error(`Git Skill source contains more than ${GIT_CANDIDATE_LIMIT} distinct candidate Skills`);
  }
  return selected;
}

function conciseGitError(stderr: string, code: number | null): string {
  const category = /certificate|SSL|TLS/iu.test(stderr) ? "TLS verification failed"
    : /407|authentication|credential/iu.test(stderr) ? "authentication required"
    : /proxy|CONNECT/iu.test(stderr) ? "public proxy connection failed"
    : /timed? ?out/iu.test(stderr) ? "connection timed out" : "repository operation failed";
  return `Git ${category} (exit ${code ?? "unknown"})`;
}

export class SkillManager implements SkillManagerLike {
  #workspacePath: string;
  readonly #catalog: SkillCatalog;
  readonly #fetch: FetchLike | undefined;
  readonly #lookup: HostLookup;
  readonly #preparations = new Map<string, PreparationRecord>();
  readonly #preparing = new Set<Promise<PreparedSkillInstall>>();
  readonly #gitProcesses = new Set<ReturnType<typeof observeProcessCompletion>>();
  readonly #lifecycleActive = new Set<Promise<void>>();
  readonly #lifecycle = new Map<string, { preview: SkillLifecyclePreview; record: ManagedSkillRecord; preparation?: PreparationRecord; candidate?: CandidateRecord }>();
  readonly #lifetime = new AbortController();
  #closed = false;
  #disposal: Promise<void> | undefined;
  #cleanupFailure: ProcessCleanupError | undefined;

  constructor(options: SkillManagerOptions) {
    this.#workspacePath = options.workspacePath;
    this.#catalog = options.catalog;
    this.#fetch = options.fetch;
    this.#lookup = options.lookup ?? publicLookup;
  }

  setWorkspace(workspacePath: string): void {
    this.#workspacePath = workspacePath;
  }

  async list(): Promise<readonly ManagedSkill[]> {
    const snapshot = await this.#catalog.refresh();
    return Promise.all(snapshot.skills.map(async (skill) => ({
      ...skill,
      conflict: snapshot.conflictedNames.includes(skill.name),
      usable: !snapshot.conflictedNames.includes(skill.name),
      skillMarkdown: await fs.readFile(skill.path, "utf8"),
      ...(await this.#managedInfo(dirname(skill.path))),
    })));
  }

  async saveCreated(skillMarkdown: string, scope: SkillTargetScope): Promise<SkillInstallResult> {
    this.#assertAvailable();
    const normalized = normalizeGeneratedSkillMarkdown(skillMarkdown);
    const metadata = validateManagedSkillMarkdown(normalized);
    await this.#assertNameAvailable(metadata.name);
    const root = await this.#targetRoot(scope);
    const source = await fs.mkdtemp(join(tmpdir(), "everpeace-skill-create-"));
    try {
      const packageDirectory = join(source, metadata.name);
      await fs.mkdir(packageDirectory);
      await fs.writeFile(join(packageDirectory, "SKILL.md"), normalized, { flag: "wx" });
      const result = await this.#commitDirectory(packageDirectory, metadata.name, scope, root);
      await this.#markManaged(result);
      return result;
    } finally {
      await fs.rm(source, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async prepareInstall(source: string, signal?: AbortSignal): Promise<PreparedSkillInstall> {
    this.#assertAvailable();
    const combined = AbortSignal.any([this.#lifetime.signal, ...(signal ? [signal] : [])]);
    const preparation = this.#prepareInstall(source, combined);
    this.#preparing.add(preparation);
    try { return await preparation; }
    finally { this.#preparing.delete(preparation); }
  }

  async #prepareInstall(source: string, signal: AbortSignal): Promise<PreparedSkillInstall> {
    const sourceUrl = this.#parseSourceUrl(source);
    signal?.throwIfAborted();
    const temporaryDirectory = await fs.mkdtemp(join(tmpdir(), "everpeace-skill-install-"));
    const id = randomUUID();
    try {
      let discoveryRoot: string;
      const github = parseGitHubSource(sourceUrl);
      const lowerPath = sourceUrl.pathname.toLowerCase();
      if (github?.ref) {
        const repositoryUrl = new URL(`https://github.com/${github.owner}/${github.repository}.git`);
        discoveryRoot = await this.#cloneRepository(
          repositoryUrl,
          join(temporaryDirectory, "repository"),
          signal,
          { ref: github.ref, ...(github.subpath ? { subpath: github.subpath } : {}) },
        );
      } else if (lowerPath.endsWith(".zip")) {
        await unzipInto(await this.#download(sourceUrl, signal), temporaryDirectory);
        discoveryRoot = temporaryDirectory;
      } else if (basename(sourceUrl.pathname).toLowerCase() === "skill.md") {
        const contents = new TextDecoder().decode(await this.#download(sourceUrl, signal));
        const metadata = validateManagedSkillMarkdown(contents);
        discoveryRoot = join(temporaryDirectory, metadata.name);
        await fs.mkdir(discoveryRoot);
        await fs.writeFile(join(discoveryRoot, "SKILL.md"), normalizeGeneratedSkillMarkdown(contents), { flag: "wx" });
      } else {
        discoveryRoot = join(temporaryDirectory, "repository");
        const repositoryUrl = github
          ? new URL(`https://github.com/${github.owner}/${github.repository}.git`)
          : sourceUrl;
        discoveryRoot = await this.#cloneRepository(repositoryUrl, discoveryRoot, signal);
      }
      signal.throwIfAborted();
      const candidates = await discoverCandidates(discoveryRoot);
      signal.throwIfAborted();
      const record: PreparationRecord = { id, sourceUrl: sourceUrl.toString(), temporaryDirectory, candidates };
      this.#preparations.set(id, record);
      return {
        id,
        sourceUrl: record.sourceUrl,
        candidates: candidates.map(({ sourceDirectory: _sourceDirectory, ...candidate }) => ({ ...candidate })),
      };
    } catch (error) {
      if (error instanceof ProcessCleanupError) {
        this.#cleanupFailure ??= error;
        throw error;
      }
      await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (signal?.aborted) throw signal.reason ?? error;
      throw error;
    }
  }

  async installPrepared(preparationId: string, candidateId: string, scope: SkillTargetScope): Promise<SkillInstallResult> {
    this.#assertAvailable();
    const preparation = this.#preparations.get(preparationId);
    if (!preparation) throw new Error("This Skill installation preview has expired");
    const candidate = preparation.candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new Error("The selected Skill is unavailable");
    try {
      await validateSkillDirectory(candidate.sourceDirectory);
      if (await exists(join(candidate.sourceDirectory, ".everpeace-managed.json"))) throw new Error("Skill source cannot supply host management metadata");
      await this.#assertNameAvailable(candidate.name);
      const root = await this.#targetRoot(scope);
      const result = await this.#commitDirectory(candidate.sourceDirectory, candidate.name, scope, root);
      await this.#markManaged(result, preparation.sourceUrl);
      return result;
    } finally {
      await this.discardPrepared(preparationId);
    }
  }

  async discardPrepared(preparationId: string): Promise<void> {
    this.#lifecycle.delete(preparationId);
    const preparation = this.#preparations.get(preparationId);
    if (!preparation) return;
    this.#preparations.delete(preparationId);
    await fs.rm(preparation.temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  close(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#closed = true;
    this.#lifetime.abort(new Error("Skill manager is closed"));
    return this.#disposal = (async () => {
      const processes = [...this.#gitProcesses];
      for (const owned of processes) owned.stop();
      const results = await Promise.all(processes.map((owned) => owned.completion));
      for (const result of results) if (result.cleanupError) this.#cleanupFailure ??= result.cleanupError;
      await Promise.allSettled([...this.#preparing, ...this.#lifecycleActive]);
      await Promise.all([...this.#preparations.keys()].map((id) => this.discardPrepared(id)));
      if (this.#cleanupFailure) throw this.#cleanupFailure;
    })();
  }

  #assertAvailable(): void {
    if (this.#cleanupFailure) throw this.#cleanupFailure;
    if (this.#closed) throw new Error("Skill manager is closed");
  }

  #parseSourceUrl(source: string): URL {
    let url: URL;
    try {
      url = new URL(source.trim());
    } catch {
      throw new Error("Skill source must be a valid absolute HTTPS URL");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new Error("Skill source must be a public HTTPS URL without credentials or fragments");
    }
    return url;
  }

  async #download(initialUrl: URL, signal?: AbortSignal): Promise<Uint8Array> {
    let current = initialUrl;
    const timeout = AbortSignal.timeout(NETWORK_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    for (let redirect = 0; redirect <= REDIRECT_LIMIT; redirect += 1) {
      if (current.protocol !== "https:" || current.username || current.password || current.hash) {
        throw new Error("Skill source redirects must remain public HTTPS URLs without credentials or fragments");
      }
      const result = await withPublicResponse(current, {
        redirect: "manual",
        signal: requestSignal,
        headers: { "User-Agent": "Everpeace-Skill-Installer/0.1", Accept: "application/octet-stream,text/plain;q=0.9" },
      }, { ...(this.#fetch ? { fetch: this.#fetch } : {}), lookup: this.#lookup }, async (response): Promise<Uint8Array | { location: string }> => {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirect === REDIRECT_LIMIT) throw new Error("Skill source exceeded the redirect limit");
          const location = response.headers.get("location");
          if (!location) throw new Error("Skill source redirect did not include a location");
          return { location };
        }
        if (!response.ok) throw new Error(`Skill source returned HTTP ${response.status}`);
        return readLimitedBytes(response);
      });
      if (result instanceof Uint8Array) return result;
      current = new URL(result.location, current);
    }
    throw new Error("Skill source exceeded the redirect limit");
  }

  async #runGit(args: readonly string[], signal: AbortSignal, stdoutLimit = 0, proxyUrl?: string): Promise<Uint8Array> {
    this.#assertAvailable();
    signal.throwIfAborted();
    const child = spawn("git", [...args], {
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", stdoutLimit > 0 ? "pipe" : "ignore", "pipe"],
      env: publicGitEnvironment(proxyUrl),
    });
    const owned = observeProcessCompletion(child, { signal });
    this.#gitProcesses.add(owned);
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let outputError: Error | undefined;
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      if (!owned.closed) stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (outputError || owned.closed || owned.stopping) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > stdoutLimit) {
        outputError = new Error(`Git output exceeds ${stdoutLimit} bytes`);
        owned.stop();
        return;
      }
      chunks.push(chunk);
    });
    let result;
    try { result = await owned.completion; }
    finally { this.#gitProcesses.delete(owned); }
    if (result.cleanupError) { this.#cleanupFailure ??= result.cleanupError; throw result.cleanupError; }
    if (result.error) throw result.error;
    if (outputError) throw outputError;
    signal.throwIfAborted();
    if (result.exitCode !== 0) throw new Error(conciseGitError(stderr, result.exitCode));
    return Buffer.concat(chunks, stdoutBytes);
  }

  async #cloneRepository(
    url: URL,
    target: string,
    signal?: AbortSignal,
    selection: { ref?: string; subpath?: string } = {},
  ): Promise<string> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(new Error("Git Skill preparation timed out")), GIT_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    let relay: Awaited<ReturnType<typeof createPublicGitRelay>> | undefined;
    try {
      relay = await createPublicGitRelay(url, combined, { lookup: this.#lookup, lifetimeSignal: new AbortController().signal });
      await this.#runGit(buildGitCloneArguments(url, target, selection.ref), combined, 0, relay.proxyUrl);
      await relay.close();
      const treeBytes = await this.#runGit(
        buildGitRepositoryArguments(target, "ls-tree", "-r", "-l", "-z", "HEAD"),
        combined,
        GIT_TREE_OUTPUT_LIMIT_BYTES,
      );
      const tree = parseGitTreeEntries(new TextDecoder().decode(treeBytes));
      const subpath = selection.subpath ? validateRepositoryPath(selection.subpath, "GitHub Skill path") : undefined;
      const manifests = tree.filter((entry) => {
        if (entry.type !== "blob" || !entry.mode.startsWith("100")) return false;
        if (posix.basename(entry.path) !== "SKILL.md") return false;
        return !subpath || entry.path === `${subpath}/SKILL.md` || entry.path.startsWith(`${subpath}/`);
      });
      if (manifests.length === 0) throw new Error("No valid SKILL.md was found in this Git source");
      if (manifests.length > GIT_MANIFEST_LIMIT) {
        throw new Error(`Git Skill source contains more than ${GIT_MANIFEST_LIMIT} SKILL.md files`);
      }

      const gitCandidates: GitSkillCandidate[] = [];
      for (const manifest of manifests) {
        const markdownBytes = await this.#runGit(
          buildGitRepositoryArguments(target, "show", `HEAD:${manifest.path}`),
          combined,
          SKILL_FILE_LIMIT_BYTES,
        );
        const markdown = new TextDecoder().decode(markdownBytes);
        const metadata = validateManagedSkillMarkdown(markdown, manifest.path);
        gitCandidates.push({ directory: posix.dirname(manifest.path), name: metadata.name });
      }
      const selected = selectGitSkillCandidates(gitCandidates);

      for (const candidate of selected) {
        const files = tree.filter((entry) => isWithinGitDirectory(entry.path, candidate.directory));
        if (files.length > SKILL_ENTRY_LIMIT) {
          throw new Error(`Skill '${candidate.name}' contains more than ${SKILL_ENTRY_LIMIT} tracked files`);
        }
        let total = 0;
        for (const entry of files) {
          const relativePath = candidate.directory === "."
            ? entry.path
            : entry.path.slice(candidate.directory.length + 1);
          if (entry.mode === "120000") throw new Error(`Symbolic links are not allowed in Git skills: ${relativePath}`);
          if (entry.type !== "blob" || entry.size === undefined) {
            throw new Error(`Unsupported Git entry in Skill '${candidate.name}': ${relativePath}`);
          }
          if (entry.size > FILE_LIMIT_BYTES) {
            throw new Error(`Skill file exceeds ${FILE_LIMIT_BYTES} bytes: ${relativePath}`);
          }
          total += entry.size;
          if (total > EXTRACTED_LIMIT_BYTES) throw new Error(`Skill '${candidate.name}' exceeds ${EXTRACTED_LIMIT_BYTES} bytes`);
        }
      }

      if (selected.some((item) => item.directory === ".")) {
        await this.#runGit(buildGitRepositoryArguments(target, "checkout", "--force", "HEAD"), combined);
      } else {
        await this.#runGit(
          buildGitRepositoryArguments(target, "sparse-checkout", "set", "--cone", "--", ...selected.map((item) => item.directory)),
          combined,
        );
        await this.#runGit(buildGitRepositoryArguments(target, "checkout", "--force", "HEAD"), combined);
      }
      const discoveryRoot = subpath ? resolve(target, ...subpath.split("/")) : target;
      const relation = relative(target, discoveryRoot);
      if (relation.startsWith("..") || isAbsolute(relation)) throw new Error("GitHub Skill path escapes its repository");
      return discoveryRoot;
    } finally {
      clearTimeout(timeout);
      await relay?.close();
    }
  }

  async #hashes(directory: string): Promise<Record<string, string>> {
    const validated = await validateSkillDirectory(directory);
    const hashes: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const name of validated.files.filter((file) => file !== ".everpeace-managed.json").sort()) hashes[name] = createHash("sha256").update(await fs.readFile(join(directory, name))).digest("hex");
    return hashes;
  }
  async #markManaged(result: SkillInstallResult, sourceUrl?: string): Promise<void> {
    const record: ManagedSkillRecord = { version: 1, name: result.name, scope: result.scope, hashes: await this.#hashes(result.directory), ...(sourceUrl ? { sourceUrl } : {}) };
    await fs.writeFile(join(result.directory, ".everpeace-managed.json"), JSON.stringify(record), { flag: "wx", mode: 0o600 });
  }
  async #managedInfo(directory: string): Promise<{ managed?: boolean; sourceUrl?: string }> {
    try { const record = await this.#managed(directory); return { managed: true, ...(record.sourceUrl ? { sourceUrl: record.sourceUrl } : {}) }; }
    catch { return {}; }
  }
  async #managed(directory: string): Promise<ManagedSkillRecord> {
    const canonical = await fs.realpath(directory);
    if (relative(resolve(directory), canonical) !== "" || (await fs.lstat(directory)).isSymbolicLink()) throw new Error("Managed Skill directory cannot be redirected");
    const marker = join(directory, ".everpeace-managed.json");
    const stat = await fs.lstat(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Skill management record is invalid");
    const record = JSON.parse(await fs.readFile(marker, "utf8")) as ManagedSkillRecord;
    if (record.version !== 1 || !["project", "user"].includes(record.scope) || record.name !== basename(directory) || !record.hashes || typeof record.hashes !== "object") throw new Error("Skill is not a managed installation");
    const target = resolve(await this.#targetRoot(record.scope), record.name);
    if (relative(target, canonical) !== "") throw new Error("Skill is outside the managed destination");
    if (record.sourceUrl) this.#parseSourceUrl(record.sourceUrl);
    return record;
  }
  async #unchanged(directory: string, record: ManagedSkillRecord): Promise<void> {
    const current = await this.#managed(directory);
    if (JSON.stringify(current) !== JSON.stringify(record) || JSON.stringify(await this.#hashes(directory)) !== JSON.stringify(record.hashes)) throw new Error("Skill has local modifications; preserve them before updating or uninstalling");
  }
  async previewUninstall(directory: string): Promise<SkillLifecyclePreview> {
    this.#assertAvailable(); const record = await this.#managed(directory); await this.#unchanged(directory, record);
    const preview: SkillLifecyclePreview = { id: randomUUID(), name: record.name, directory, action: "uninstall", changedFiles: Object.keys(record.hashes), diff: `Remove managed Skill ${record.name} (${Object.keys(record.hashes).length} files) from ${directory}` };
    this.#lifecycle.set(preview.id, { preview, record }); return preview;
  }
  async previewUpdate(directory: string, signal?: AbortSignal): Promise<SkillLifecyclePreview> {
    this.#assertAvailable(); const record = await this.#managed(directory); await this.#unchanged(directory, record);
    if (!record.sourceUrl) throw new Error("Locally created Skills have no remote update source");
    const prepared = await this.prepareInstall(record.sourceUrl, signal);
    try {
      const preparation = this.#preparations.get(prepared.id)!;
      const candidates = preparation.candidates.filter((candidate) => candidate.name === record.name);
      if (candidates.length !== 1) throw new Error("Update source must contain exactly one matching Skill name");
      const candidate = candidates[0]!;
      const hashes = await this.#hashes(candidate.sourceDirectory);
      const changedFiles = [...new Set([...Object.keys(record.hashes), ...Object.keys(hashes)])].filter((file) => record.hashes[file] !== hashes[file]);
      let diff = "";
      for (const file of changedFiles) {
        const before = record.hashes[file] ? await fs.readFile(join(directory, file), "utf8") : "";
        const after = hashes[file] ? await fs.readFile(join(candidate.sourceDirectory, file), "utf8") : "";
        diff += `\n--- ${file}\n+++ ${file}\n${before.split("\n").map((line) => `- ${line}`).join("\n")}\n${after.split("\n").map((line) => `+ ${line}`).join("\n")}`;
        if (Buffer.byteLength(diff) > 64 * 1024) throw new Error("Skill update preview is too large; inspect the source manually");
      }
      await this.#unchanged(directory, record);
      const preview: SkillLifecyclePreview = { id: prepared.id, name: record.name, directory, sourceUrl: record.sourceUrl, action: "update", diff: diff || "No content changes", changedFiles };
      this.#lifecycle.set(preview.id, { preview, record, preparation, candidate }); return preview;
    } catch (error) { await this.discardPrepared(prepared.id); throw error; }
  }
  async commitLifecycle(id: string): Promise<void> {
    this.#assertAvailable();
    const operation = this.#commitLifecycle(id);
    this.#lifecycleActive.add(operation);
    try { await operation; } finally { this.#lifecycleActive.delete(operation); }
  }
  async #commitLifecycle(id: string): Promise<void> {
    this.#assertAvailable();
    const operation = this.#lifecycle.get(id); if (!operation) throw new Error("Skill lifecycle preview expired");
    this.#lifecycle.delete(id);
    const { preview, record, candidate } = operation;
    const root = await fs.realpath(dirname(preview.directory));
    const backup = join(root, `.${record.name}.everpeace-backup-${randomUUID()}`);
    const staging = join(root, `.${record.name}.everpeace-update-${randomUUID()}`);
    try {
      await this.#unchanged(preview.directory, record);
      if (preview.action === "update") {
        const snapshot = await this.#catalog.refresh();
        if (snapshot.skills.some((skill) => skill.name === record.name && relative(resolve(dirname(skill.path)), resolve(preview.directory)) !== "")) throw new Error("Skill name is ambiguous; resolve duplicates before updating");
        if (!candidate) throw new Error("Update candidate is unavailable");
        await copySkillTree(candidate.sourceDirectory, staging); await validateSkillDirectory(staging);
        const marker = join(staging, ".everpeace-managed.json"); if (await exists(marker)) throw new Error("Update source must not include host management metadata");
        await fs.writeFile(marker, JSON.stringify({ ...record, hashes: await this.#hashes(staging) }), { flag: "wx", mode: 0o600 });
      }
      this.#assertAvailable();
      await this.#unchanged(preview.directory, record);
      await fs.rename(preview.directory, backup);
      // Recheck the moved bytes before discarding the original directory.
      if (JSON.stringify(JSON.parse(await fs.readFile(join(backup, ".everpeace-managed.json"), "utf8"))) !== JSON.stringify(record) || JSON.stringify(await this.#hashes(backup)) !== JSON.stringify(record.hashes)) {
        await fs.rename(backup, preview.directory); throw new Error("Skill changed during confirmation; update refused");
      }
      if (preview.action === "update") {
        try { await fs.rename(staging, preview.directory); }
        catch (error) { if (!await exists(preview.directory)) await fs.rename(backup, preview.directory); throw error; }
      }
      const resolvedBackup = await fs.realpath(backup);
      if (dirname(resolvedBackup) !== root || !basename(resolvedBackup).startsWith(`.${record.name}.everpeace-backup-`)) throw new Error("Unsafe Skill cleanup target");
      await fs.rm(resolvedBackup, { recursive: true });
      await this.#catalog.refresh();
    } finally {
      if (await exists(staging)) { const safe = await fs.realpath(staging); if (dirname(safe) === root && basename(safe).startsWith(`.${record.name}.everpeace-update-`)) await fs.rm(safe, { recursive: true }); }
      if (operation.preparation) await this.discardPrepared(operation.preparation.id);
    }
  }
  async #targetRoot(scope: SkillTargetScope): Promise<string> {
    return scope === "user"
      ? join(codexHome(), "skills")
      : join(await findProjectRoot(this.#workspacePath), ".agents", "skills");
  }

  async #assertNameAvailable(name: string): Promise<void> {
    const snapshot: SkillSnapshot = await this.#catalog.refresh();
    const matches = snapshot.skills.filter((skill) => skill.name === name);
    if (matches.length > 0) {
      throw new Error(`Skill '${name}' already exists:\n${matches.map((skill) => skill.path).join("\n")}`);
    }
  }

  async #commitDirectory(source: string, name: string, scope: SkillTargetScope, root: string): Promise<SkillInstallResult> {
    assertSkillName(name);
    await fs.mkdir(root, { recursive: true });
    const target = join(root, name);
    if (await exists(target)) throw new Error(`Destination already exists: ${target}`);
    const staging = join(root, `.${name}.everpeace-${randomUUID()}`);
    try {
      await copySkillTree(source, staging);
      await validateSkillDirectory(staging);
      await fs.rename(staging, target);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(`Could not install Skill: ${errorMessage(error)}`);
    }
    await this.#catalog.refresh();
    return { name, directory: target, scope };
  }
}
