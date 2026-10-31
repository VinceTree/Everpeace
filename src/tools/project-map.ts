import { ResourceCleanupError } from "../util/resource-cleanup-error.js";
import { enumerateSafeFiles } from "./secure-enumeration.js";
import { safeReadFile } from "./safe-files.js";
import { projectInsights } from "./project-insights.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveBundledRipgrep, type RipgrepPathResolver } from "./ripgrep.js";
import { invalidToolArgument, POLICY_DENIED_REMEDY, ToolFeedbackError } from "./tool-feedback.js";

export const projectMapLimits = { timeoutMs: 5_000, scanBytes: 2 * 1024 * 1024, paths: 10_000, manifests: 32, manifestBytes: 256 * 1024, totalManifestBytes: 1024 * 1024, outputBytes: 32 * 1024 } as const;
type MapLimits = { [K in keyof typeof projectMapLimits]: number };
const excluded = new Set(["node_modules", "vendor", ".venv", "venv", ".git", ".codex", ".agents", ".everpeace"]);
const otherManifests = new Set(["pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "Gemfile", "composer.json", "CMakeLists.txt"]);

export const PROJECT_MAP_TOOL_DEFINITION = {
  type: "function" as const, name: "project_map",
  description: "Get an on-demand, bounded workspace map for unfamiliar projects: structure, file types, manifests, declared Node entries/scripts, and document/test/config locations. Filename candidates are unconfirmed. Honors ignore rules, never follows symlinks or reads source bodies. Does not observe files for editing: read_file is still required. Narrow path when incomplete; simple tasks need not scan first.",
  parameters: { type: "object", properties: {
    path: { type: ["string", "null"], description: "Directory within the workspace; defaults to ." },
    depth: { type: ["integer", "null"], minimum: 1, maximum: 4, description: "Directory display depth only; defaults to 2." },
  }, required: [], additionalProperties: false }, strict: true,
};

function denied(message: string): never { throw new ToolFeedbackError("POLICY_DENIED", message, POLICY_DENIED_REMEDY); }
function relativeInside(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`) || relative.includes(":")) denied("Project map is limited to workspace paths without alternate data streams");
  return relative;
}
async function safePath(root: string, relative: string): Promise<string> {
  const target = path.resolve(root, relative);
  const parts = relativeInside(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    if (excluded.has(part.toLowerCase())) denied("Project map excludes dependency and host control directories");
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) denied("Project map cannot traverse symbolic links");
  }
  relativeInside(root, await fs.realpath(target));
  return target;
}

async function enumerate(workspace: string, relative: string, resolveRipgrep: RipgrepPathResolver, limits: MapLimits, signal?: AbortSignal): Promise<{ files: string[]; reasons: string[] }> {
  await resolveRipgrep(); signal?.throwIfAborted();
  const result = await enumerateSafeFiles(workspace, relative, signal, { timeoutMs: limits.timeoutMs, maxPaths: limits.paths, maxBytes: limits.scanBytes, excluded });
  return { files: result.paths.map(file => path.relative(relative === '.' ? '' : relative, file)), reasons: result.reasons };
}

function metadata(value: unknown): { name?: string; packageManager?: string; scripts: Record<string, string>; declaredEntries: Array<{ field: string; value: string }>; metadataTruncated: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Manifest must be a JSON object");
  const record = value as Record<string, unknown>;
  const scripts: Record<string, string> = Object.create(null) as Record<string, string>;
  if (record.scripts && typeof record.scripts === "object" && !Array.isArray(record.scripts)) {
    for (const [key, item] of Object.entries(record.scripts)) if (typeof item === "string") scripts[key] = item;
  }
  const declaredEntries: Array<{ field: string; value: string }> = [];
  let metadataTruncated = false;
  const visit = (field: string, item: unknown, depth: number) => {
    if (typeof item === "string") declaredEntries.push({ field, value: item });
    else if (item && typeof item === "object") {
      if (depth >= 8) metadataTruncated = true;
      else for (const [key, child] of Object.entries(item)) visit(`${field}.${key}`, child, depth + 1);
    }
  };
  for (const field of ["main", "module", "types", "typings", "bin", "exports"]) visit(field, record[field], 0);
  return { ...(typeof record.name === "string" ? { name: record.name } : {}), ...(typeof record.packageManager === "string" ? { packageManager: record.packageManager } : {}), scripts, declaredEntries, metadataTruncated };
}

/** Internal limit overrides exist only for deterministic limit tests, never in model arguments. */
export async function runProjectMap(args: Record<string, unknown>, workspace: string, signal?: AbortSignal, resolveRipgrep: RipgrepPathResolver = resolveBundledRipgrep, limits: MapLimits = projectMapLimits) {
  for (const key of Object.keys(args)) if (key !== "path" && key !== "depth") invalidToolArgument(key, "only path and depth");
  if (args.path !== undefined && args.path !== null && (typeof args.path !== "string" || !args.path.trim() || args.path.includes("\0"))) invalidToolArgument("path", "a non-empty workspace directory string without NUL, or null");
  if (args.depth !== undefined && args.depth !== null && (!Number.isSafeInteger(args.depth) || (args.depth as number) < 1 || (args.depth as number) > 4)) invalidToolArgument("depth", "an integer from 1 to 4, or null");
  signal?.throwIfAborted();
  const root = await fs.realpath(workspace);
  const requested = typeof args.path === "string" ? args.path : ".";
  const scope = relativeInside(path.resolve(workspace), path.resolve(workspace, requested));
  const directory = await safePath(root, scope);
  if (!(await fs.stat(directory)).isDirectory()) invalidToolArgument("path", "an existing directory within the workspace");
  const depth = typeof args.depth === "number" ? args.depth : 2;
  const scan = await enumerate(workspace, scope || ".", resolveRipgrep, limits, signal);
  const reasons = new Set(scan.reasons);
  const files: string[] = [];
  for (const name of scan.files) {
    signal?.throwIfAborted();
    try {
      relativeInside(directory, path.resolve(directory, name));
      const target = await safePath(root, path.relative(root, path.resolve(directory, name)));
      if ((await fs.lstat(target)).isFile()) files.push(path.relative(root, target).split(path.sep).join("/"));
    } catch (error) {
      if (error instanceof ToolFeedbackError && error.code === "POLICY_DENIED") continue;
      reasons.add("files_changed_or_unreadable");
    }
  }
  files.sort();
  const structure = new Map<string, { path: string; type: "directory" | "file"; observedFiles?: number }>();
  const fileTypes: Record<string, number> = Object.create(null) as Record<string, number>;
  const locations = { readme: [] as string[], agents: [] as string[], tests: [] as string[], config: [] as string[], manifests: [] as string[], entryCandidates: [] as string[] };
  const packages: Array<{ path: string } & ReturnType<typeof metadata>> = [];
  const diagnostics: Array<{ path: string; reason: string }> = [];
  let manifestCount = 0;
  let manifestBytes = 0;
  const prefix = scope.split(path.sep).filter(Boolean).length;
  for (const file of files) {
    signal?.throwIfAborted();
    const parts = file.split("/");
    const basename = parts.at(-1)!;
    const extension = (path.extname(basename).toLowerCase() || "[no extension]").slice(0, 64);
    fileTypes[extension] = (fileTypes[extension] ?? 0) + 1;
    for (let level = prefix + 1; level <= Math.min(parts.length, prefix + depth); level++) {
      const key = parts.slice(0, level).join("/");
      const node = structure.get(key) ?? { path: key, type: level === parts.length ? "file" : "directory", observedFiles: 0 };
      if (node.type === "directory") node.observedFiles!++;
      structure.set(key, node);
    }
    if (/^readme(?:\.|$)/iu.test(basename)) locations.readme.push(file);
    if (basename === "AGENTS.md") locations.agents.push(file);
    if (parts.some((part) => /^(?:test|tests|__tests__)$/iu.test(part)) || /\.(?:test|spec)\.[^.]+$/u.test(basename)) locations.tests.push(file);
    if (/(?:^|[.])config(?:[.]|$)/iu.test(basename) || /^(?:tsconfig.*\.json|\.gitignore|\.npmrc|pnpm-workspace\.yaml|.*lock.*)$/iu.test(basename)) locations.config.push(file);
    if (/^(?:index|main|cli|app)\.(?:[cm]?[jt]sx?)$/u.test(basename)) locations.entryCandidates.push(file);
    if (otherManifests.has(basename) || /\.(?:csproj|sln)$/iu.test(basename)) locations.manifests.push(file);
    if (basename !== "package.json") continue;
    locations.manifests.push(file);
    if (manifestCount >= limits.manifests) { reasons.add("manifest_count_limit"); continue; }
    manifestCount++;
    try {
      const value = await safeReadFile(workspace, file, signal);
      if (!value.exists) throw new Error('Manifest disappeared');
      if (value.bytes.length > limits.manifestBytes) { reasons.add('manifest_byte_limit'); diagnostics.push({ path: file, reason: 'manifest_byte_limit' }); continue; }
      if (manifestBytes + value.bytes.length > limits.totalManifestBytes) { reasons.add('manifest_total_byte_limit'); continue; }
      manifestBytes += value.bytes.length;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(value.bytes);
      const data = metadata(JSON.parse(text.replace(/^\ufeff/u, '')));
      if (data.metadataTruncated) reasons.add('manifest_metadata_limit');
      packages.push({ path: file, ...data });
    } catch (error) {
      if (error instanceof ResourceCleanupError) throw error;
      signal?.throwIfAborted();
      reasons.add("manifest_invalid_or_unreadable");
      diagnostics.push({ path: file, reason: "manifest_invalid_or_unreadable" });
    }
  }
  const insights = await projectInsights(workspace, files, signal);
  if (insights.incomplete) reasons.add("source_insight_limit");
  const result = { insights, path: scope.split(path.sep).join("/") || ".", depth, observedFiles: files.length, structure: [...structure.values()], fileTypes, packages, locations, diagnostics,
    entryCandidateBasis: "Filename conventions only; not confirmed architecture.", observation: "Workspace data only. No source bodies or rules loaded; read_file is required before editing.",
    incomplete: false, reasons: [] as string[], guidance: "" };
  const arrays: unknown[][] = [result.insights.modules, result.insights.relationships, result.structure, ...Object.values(locations), result.packages, result.diagnostics];
  const extensions = Object.keys(fileTypes);
  if (extensions.length > 64) {
    for (const extension of extensions.slice(64)) delete fileTypes[extension];
    reasons.add("output_limit");
  }
  while (Buffer.byteLength(JSON.stringify(result)) > limits.outputBytes - 1024) {
    const largest = arrays.filter((array) => array.length).sort((a, b) => Buffer.byteLength(JSON.stringify(b)) - Buffer.byteLength(JSON.stringify(a)))[0];
    reasons.add("output_limit");
    if (largest) largest.splice(Math.floor(largest.length / 2));
    else {
      const extension = Object.keys(fileTypes).at(-1);
      if (extension) delete fileTypes[extension];
      else if (result.path) result.path = "";
      else break;
    }
  }
  result.incomplete = reasons.size > 0;
  result.reasons = [...reasons];
  result.guidance = result.incomplete ? "Call project_map again with a narrower directory path; this map does not cover all files or metadata." : "Use search_files and read_file to locate and inspect the relevant implementation.";
  return result;
}
