import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { VerificationCommand, VerificationTier } from '../workflow/types.js';
const MAX_MANIFEST_BYTES = 256 * 1024;
const DEFAULT_FAST_TIMEOUT_MS = 60000;
const DEFAULT_FULL_TIMEOUT_MS = 120000;
interface PackageManifest {
    scripts?: Record<string, unknown>;
    packageManager?: string;
}
async function exists(filePath: string): Promise<boolean> {
    try {
        const stat = await fs.stat(filePath);
        return stat.isFile();
    }
    catch {
        return false;
    }
}
async function readJson(filePath: string): Promise<PackageManifest | undefined> {
    try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES)
            return undefined;
        const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value))
            return undefined;
        const record = value as {
            scripts?: unknown;
            packageManager?: unknown;
        };
        const scripts = record.scripts;
        const packageManager = typeof record.packageManager === "string" ? record.packageManager : undefined;
        return {
            scripts: scripts && typeof scripts === "object" && !Array.isArray(scripts)
                ? scripts as Record<string, unknown>
                : {},
            ...(packageManager ? { packageManager } : {}),
        };
    }
    catch {
        return undefined;
    }
}
function packageManager(workspacePath: string, manifest: PackageManifest): string {
    const declared = manifest.packageManager?.match(/^(pnpm|npm|yarn|bun)@/iu)?.[1]?.toLowerCase();
    if (declared)
        return declared;
    const workspace = path.resolve(workspacePath);
    if (fileExists(path.join(workspace, "bun.lockb")) || fileExists(path.join(workspace, "bun.lock")))
        return "bun";
    if (fileExists(path.join(workspace, "yarn.lock")))
        return "yarn";
    if (fileExists(path.join(workspace, "package-lock.json")))
        return "npm";
    return "pnpm";
}
function fileExists(filePath: string): boolean {
    return existsSync(filePath);
}
function commandForPackageScript(manager: string, script: string): string {
    // PowerShell may select an unsigned .ps1 shim. Keep host-discovered checks
    // on the native batch shim without changing the sandbox or execution policy.
    const executable = process.platform === "win32" && ["pnpm", "npm", "yarn"].includes(manager) ? `${manager}.cmd` : manager;
    return `${executable} run ${script}`;
}
function scriptCommand(manifest: PackageManifest, workspacePath: string, script: string, tier: VerificationTier): VerificationCommand | undefined {
    if (manifest.scripts?.[script] === undefined)
        return undefined;
    return {
        id: `node:${script}`,
        label: `Node ${script}`,
        command: commandForPackageScript(packageManager(workspacePath, manifest), script),
        tier,
        timeoutMs: tier === "fast" ? DEFAULT_FAST_TIMEOUT_MS : DEFAULT_FULL_TIMEOUT_MS,
    };
}
export type ProjectKind = 'node' | 'python' | 'rust' | 'go';
export interface ProjectDiagnostic {
    readonly category: 'environment' | 'unknown';
    readonly raw: string;
    readonly missingTool?: string;
}
export interface ProjectAdapter {
    readonly kind: ProjectKind;
    readonly support: 'full' | 'basic';
    recognize(workspace: string): Promise<boolean>;
    toolchain(workspace: string): Promise<readonly string[]>;
    checks(workspace: string): Promise<VerificationCommand[]>;
    explain(raw: string): ProjectDiagnostic;
}
function explain(raw: string): ProjectDiagnostic {
    // Missing tools must be explicit. Unrecognized compiler output is not code failure evidence.
    const match = raw.match(/(?:^|\n)([\w.-]+): command not found\b/);
    return match ? { category: 'environment', raw, missingTool: match[1]! } : { category: 'unknown', raw };
}
const node: ProjectAdapter = { kind: 'node', support: 'full', recognize: async (workspace) => !!await readJson(path.join(workspace, 'package.json')), async toolchain(workspace) { const manifest = await readJson(path.join(workspace, 'package.json')); return manifest ? ['node', packageManager(workspace, manifest)] : []; }, async checks(workspace) { const manifest = await readJson(path.join(workspace, 'package.json')); if (!manifest)
        return []; const fast = manifest.scripts?.typecheck !== undefined ? 'typecheck' : manifest.scripts?.lint !== undefined ? 'lint' : undefined; return ['typecheck', 'lint', 'test', 'build'].flatMap(script => { const command = scriptCommand(manifest, workspace, script, script === fast ? 'fast' : 'full'); return command ? [command] : []; }); }, explain };
const python: ProjectAdapter = { kind: 'python', support: 'basic', recognize: async (workspace) => await exists(path.join(workspace, 'pyproject.toml')) || await exists(path.join(workspace, 'pytest.ini')), toolchain: async () => ['python'], checks: async () => [{ id: 'python:pytest', label: 'Python tests', command: 'python -m pytest', tier: 'full', timeoutMs: DEFAULT_FULL_TIMEOUT_MS }], explain };
const rust: ProjectAdapter = { kind: 'rust', support: 'basic', recognize: workspace => exists(path.join(workspace, 'Cargo.toml')), toolchain: async () => ['cargo'], checks: async () => [{ id: 'rust:check', label: 'Cargo check', command: 'cargo check', tier: 'fast', timeoutMs: DEFAULT_FAST_TIMEOUT_MS }, { id: 'rust:test', label: 'Cargo tests', command: 'cargo test', tier: 'full', timeoutMs: DEFAULT_FULL_TIMEOUT_MS }], explain };
const go: ProjectAdapter = { kind: 'go', support: 'basic', recognize: workspace => exists(path.join(workspace, 'go.mod')), toolchain: async () => ['go'], checks: async () => [{ id: 'go:test', label: 'Go tests', command: 'go test ./...', tier: 'full', timeoutMs: DEFAULT_FULL_TIMEOUT_MS }], explain };
export const PROJECT_ADAPTERS: readonly ProjectAdapter[] = Object.freeze([node, python, rust, go].map(adapter => Object.freeze(adapter)));
/** Read-only detection in the historical priority order. No plugins or installs. */
export async function detectProjectAdapter(workspace: string): Promise<ProjectAdapter | undefined> { for (const adapter of PROJECT_ADAPTERS)
    if (await adapter.recognize(workspace))
        return adapter; return undefined; }
export async function discoverProjectChecks(workspace: string): Promise<VerificationCommand[]> { return (await detectProjectAdapter(workspace))?.checks(workspace) ?? []; }
