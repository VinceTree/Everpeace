import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { parse as parseYaml } from "yaml";

const MAX_SKILL_NAME_CHARS = 64;
const MAX_SKILL_FILE_BYTES = 512 * 1024;
const SKILL_PAGE_CHARS = 32 * 1024;
const MAX_CATALOG_CHARS = 8_000;
const MAX_SCAN_ENTRIES = 20_000;
const MAX_SCAN_DEPTH = 8;

export type SkillScope = "repo" | "user" | "admin" | "system";

export interface SkillMetadata {
  name: string;
  description: string;
  shortDescription?: string;
  path: string;
  directory: string;
  scope: SkillScope;
}

export interface SkillError {
  path: string;
  message: string;
}

export interface SkillSnapshot {
  skills: readonly SkillMetadata[];
  errors: readonly SkillError[];
  conflictedNames: readonly string[];
  instructions: string;
}

export interface SkillTurnContext extends SkillSnapshot {
  explicitInstructions: string;
  explicitNames: readonly string[];
}

export interface SkillReadResult {
  name: string;
  resource: string;
  contents: string;
  next_cursor: string | null;
}

export interface SkillCatalogLike {
  prepareTurn(input: string): Promise<SkillTurnContext>;
  read(argumentsJson: string): Promise<string>;
}

export const READ_SKILL_TOOL_DEFINITION = {
  type: "function",
  name: "read_skill",
  description:
    "Read a discovered Codex skill or one of its referenced text resources. Read the complete SKILL.md before following it; if next_cursor is returned, call this tool again with that cursor.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The skill name from the available-skills catalog." },
      resource: { type: "string", description: "Optional path relative to the skill directory. Omit it for SKILL.md." },
      cursor: { type: "string", description: "Pagination cursor returned by the previous read_skill call." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  strict: true,
} as const;

interface SkillRoot {
  path: string;
  scope: SkillScope;
}

function cleanSingleLine(value: unknown): string {
  return typeof value === "string" ? value.split(/\s+/u).filter(Boolean).join(" ") : "";
}

export function parseSkillMetadata(
  contents: string,
  path: string,
  scope: SkillScope,
): SkillMetadata {
  const lines = contents.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") throw new Error("missing YAML frontmatter delimited by ---");
  const closing = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closing < 0) throw new Error("missing YAML frontmatter delimited by ---");
  const parsed = parseYaml(lines.slice(1, closing + 1).join("\n")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid YAML frontmatter");
  const frontmatter = parsed as Record<string, unknown>;
  const name = cleanSingleLine(frontmatter.name) || basename(dirname(path));
  const description = cleanSingleLine(frontmatter.description);
  if (!name) throw new Error("missing field `name`");
  if ([...name].length > MAX_SKILL_NAME_CHARS) throw new Error(`name exceeds ${MAX_SKILL_NAME_CHARS} characters`);
  if (!description) throw new Error("missing field `description`");
  const metadata = frontmatter.metadata;
  const shortDescription = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? cleanSingleLine((metadata as Record<string, unknown>)["short-description"])
    : "";
  return {
    name,
    description,
    ...(shortDescription ? { shortDescription } : {}),
    path,
    directory: dirname(path),
    scope,
  };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
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

async function skillRoots(workspacePath: string): Promise<SkillRoot[]> {
  const workspace = resolve(workspacePath);
  const projectRoot = await findProjectRoot(workspace);
  const roots: SkillRoot[] = [];
  let current = workspace;
  while (true) {
    roots.push({ path: join(current, ".agents", "skills"), scope: "repo" });
    if (current === projectRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  roots.push({ path: join(projectRoot, ".codex", "skills"), scope: "repo" });
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  roots.push({ path: join(codexHome, "skills", ".system"), scope: "system" });
  roots.push({ path: join(codexHome, "skills"), scope: "user" });
  roots.push({ path: join(homedir(), ".agents", "skills"), scope: "user" });
  if (process.platform !== "win32") roots.push({ path: "/etc/codex/skills", scope: "admin" });
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = process.platform === "win32" ? resolve(root.path).toLowerCase() : resolve(root.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function discoverRoot(root: SkillRoot): Promise<{ skills: SkillMetadata[]; errors: SkillError[] }> {
  const skills: SkillMetadata[] = [];
  const errors: SkillError[] = [];
  if (!(await isDirectory(root.path))) return { skills, errors };
  const queue: Array<{ path: string; depth: number }> = [{ path: root.path, depth: 0 }];
  const visited = new Set<string>();
  let entriesSeen = 0;
  while (queue.length > 0 && entriesSeen < MAX_SCAN_ENTRIES) {
    const item = queue.shift()!;
    let canonical: string;
    try {
      canonical = await fs.realpath(item.path);
    } catch (error) {
      errors.push({ path: item.path, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const visitKey = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    let entries;
    try {
      entries = await fs.readdir(canonical, { withFileTypes: true });
    } catch (error) {
      errors.push({ path: canonical, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    entriesSeen += entries.length;
    const skillFile = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");
    if (skillFile) {
      const path = join(canonical, skillFile.name);
      try {
        const stats = await fs.stat(path);
        if (stats.size > MAX_SKILL_FILE_BYTES) throw new Error(`SKILL.md exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
        skills.push(parseSkillMetadata(await fs.readFile(path, "utf8"), path, root.scope));
      } catch (error) {
        errors.push({ path, message: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }
    if (item.depth >= MAX_SCAN_DEPTH) continue;
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const child = join(canonical, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        try {
          if ((await fs.stat(child)).isDirectory()) queue.push({ path: child, depth: item.depth + 1 });
        } catch (error) {
          errors.push({ path: child, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }
  if (entriesSeen >= MAX_SCAN_ENTRIES) errors.push({ path: root.path, message: "skill scan reached its entry limit" });
  return { skills, errors };
}

function skillNameCounts(skills: readonly SkillMetadata[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const skill of skills) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
  return counts;
}

function catalogInstructions(skills: readonly SkillMetadata[]): string {
  if (skills.length === 0) return "";
  const header = `## Skills
A skill is a local instruction package. The catalog below contains only metadata. If the user names a skill with $skill-name, its full SKILL.md is supplied separately for this turn. If a task clearly matches a description, call read_skill and read the entire SKILL.md before acting. Do not carry skills into later turns unless they are mentioned or matched again.

### Available skills
`;
  let result = header;
  for (const skill of skills) {
    const line = `- ${skill.name}: ${skill.description} (file: ${skill.path})\n`;
    if (result.length + line.length > MAX_CATALOG_CHARS) {
      result += "- Additional skills omitted because the catalog reached its context budget. Use /skills to inspect the full local list.\n";
      break;
    }
    result += line;
  }
  return result.trimEnd();
}

function explicitMentions(input: string): string[] {
  const names: string[] = [];
  const pattern = /(?:^|[^A-Za-z0-9_-])\$([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?=$|[^A-Za-z0-9_-])/gu;
  for (const match of input.matchAll(pattern)) {
    const name = match[1]!;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export class SkillCatalog {
  #workspacePath: string;
  #generation = 0;
  #snapshot: SkillSnapshot = { skills: [], errors: [], conflictedNames: [], instructions: "" };

  constructor(workspacePath: string) {
    this.#workspacePath = workspacePath;
  }

  setWorkspace(workspacePath: string): void {
    this.#workspacePath = workspacePath;
    this.#generation++;
    this.#snapshot = { skills: [], errors: [], conflictedNames: [], instructions: "" };
  }

  async refresh(): Promise<SkillSnapshot> {
    const generation = this.#generation;
    const roots = await skillRoots(this.#workspacePath);
    const loaded = await Promise.all(roots.map(discoverRoot));
    const seenPaths = new Set<string>();
    const skills = loaded.flatMap((item) => item.skills).filter((skill) => {
      const key = process.platform === "win32" ? skill.path.toLowerCase() : skill.path;
      if (seenPaths.has(key)) return false;
      seenPaths.add(key);
      return true;
    });
    const errors = loaded.flatMap((item) => item.errors);
    if (generation !== this.#generation) return this.snapshot();
    const counts = skillNameCounts(skills);
    const conflictedNames = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name)
      .sort();
    const usableSkills = skills.filter((skill) => counts.get(skill.name) === 1);
    this.#snapshot = {
      skills,
      errors,
      conflictedNames,
      instructions: catalogInstructions(usableSkills),
    };
    return this.snapshot();
  }

  snapshot(): SkillSnapshot {
    return {
      skills: this.#snapshot.skills.map((skill) => ({ ...skill })),
      errors: this.#snapshot.errors.map((error) => ({ ...error })),
      conflictedNames: [...this.#snapshot.conflictedNames],
      instructions: this.#snapshot.instructions,
    };
  }

  async prepareTurn(input: string): Promise<SkillTurnContext> {
    const snapshot = await this.refresh();
    const explicitNames = explicitMentions(input);
    const bodies: string[] = [];
    for (const name of explicitNames) {
      const matches = snapshot.skills.filter((candidate) => candidate.name === name);
      if (matches.length > 1) {
        bodies.push(`Explicit skill $${name} is ambiguous. Open /skills and resolve the duplicate installations before using it.`);
        continue;
      }
      const skill = matches[0];
      if (!skill) {
        bodies.push(`Explicit skill $${name} is not available.`);
        continue;
      }
      try {
        const body = await fs.readFile(skill.path, "utf8");
        bodies.push(`## Explicit skill: ${skill.name}\nSource: ${skill.path}\n\n${body}`);
      } catch (error) {
        bodies.push(`Explicit skill $${name} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      ...snapshot,
      explicitNames,
      explicitInstructions: bodies.join("\n\n"),
    };
  }

  readableRoots(): string[] {
    return [...new Set(this.#snapshot.skills.map((skill) => skill.directory))];
  }

  async read(argumentsJson: string): Promise<string> {
    let args: { name?: unknown; resource?: unknown; cursor?: unknown };
    try {
      args = JSON.parse(argumentsJson) as typeof args;
    } catch {
      return JSON.stringify({ status: "error", error: "Invalid read_skill arguments" });
    }
    if (typeof args.name !== "string" || !args.name) {
      return JSON.stringify({ status: "error", error: "read_skill requires a skill name" });
    }
    const matches = this.#snapshot.skills.filter((candidate) => candidate.name === args.name);
    if (matches.length > 1) return JSON.stringify({ status: "error", error: `Skill name is ambiguous: ${args.name}` });
    const skill = matches[0];
    if (!skill) return JSON.stringify({ status: "error", error: `Skill is unavailable: ${args.name}` });
    const resource = typeof args.resource === "string" && args.resource ? args.resource : "SKILL.md";
    if (isAbsolute(resource)) return JSON.stringify({ status: "error", error: "Skill resources must use relative paths" });
    let path: string;
    try {
      const root = await fs.realpath(skill.directory);
      path = await fs.realpath(resolve(root, resource));
      const relation = relative(root, path);
      if (relation.startsWith("..") || isAbsolute(relation)) throw new Error("resource escapes the skill directory");
      const stats = await fs.stat(path);
      if (!stats.isFile()) throw new Error("resource is not a file");
      if (stats.size > MAX_SKILL_FILE_BYTES) throw new Error(`resource exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
    } catch (error) {
      return JSON.stringify({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
    const contents = await fs.readFile(path, "utf8");
    const cursor = args.cursor === undefined ? 0 : Number(args.cursor);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > contents.length) {
      return JSON.stringify({ status: "error", error: "Invalid read_skill cursor" });
    }
    const end = Math.min(contents.length, cursor + SKILL_PAGE_CHARS);
    const result: SkillReadResult = {
      name: skill.name,
      resource,
      contents: contents.slice(cursor, end),
      next_cursor: end < contents.length ? String(end) : null,
    };
    return JSON.stringify({ status: "ok", data: result });
  }
}

export function formatSkillsStatus(snapshot: SkillSnapshot): string {
  const lines = snapshot.skills.map(
    (skill) => `${skill.name} · ${skill.scope}${snapshot.conflictedNames.includes(skill.name) ? " · conflict" : ""}\n  ${skill.description}\n  ${skill.path}`,
  );
  if (snapshot.errors.length > 0) {
    lines.push(`${snapshot.errors.length} skill path${snapshot.errors.length === 1 ? "" : "s"} could not be loaded.`);
  }
  return lines.length > 0 ? lines.join("\n") : "No skills were found in project, user, admin, or system skill roots.";
}
