import { execFile } from "node:child_process";
import { access, constants, lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { modelShellEnvironment } from "../tools/sandbox-policy.js";
import type { UiLanguage } from "../localization/language.js";
import { uiText } from "../localization/messages.js";
import { normalizeWorkspacePath } from "../memory/learned-memory.js";
import { workspaceRelativePath } from "./harness-files.js";
import { WebRequestError } from "./workbench.js";

export interface HarnessDesktop {
  readonly available: boolean;
  apps(): Promise<readonly string[]>;
  icon(id: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  openDirectory(id: string, verify: () => Promise<string>, signal: AbortSignal): Promise<"launched" | "failed" | "unavailable">;
  applications(path: string, signal: AbortSignal): Promise<unknown>;
  openFile(path: string, action: "open" | "reveal", application: string | undefined, signal: AbortSignal): Promise<void>;
}

const execute = promisify(execFile);
const systemCommands = new Map([
  ["explorer.exe", ["explorer.exe"]],
  ["reg.exe", ["System32", "reg.exe"]],
  ["powershell.exe", ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"]],
]);

async function resolveExecutable(command: string): Promise<string | null> {
  const windows = process.platform === "win32";
  const system = windows && systemCommands.get(command.toLowerCase());
  const root = process.env.SystemRoot;
  if (system && (!root || !path.isAbsolute(root))) return null;
  const suffix = windows && !path.extname(command) ? ".exe" : "";
  const candidates = system ? [path.join(root!, ...system)] : path.isAbsolute(command) ? [command]
    : (process.env.PATH ?? "").split(path.delimiter).filter(directory => path.isAbsolute(directory))
        .map(directory => path.join(directory, command + suffix));
  for (const candidate of candidates) {
    if (windows && !/^[a-z]:[/\\].*\.exe$/iu.test(candidate)) continue;
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, windows ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch { /* The application may not be installed. */ }
  }
  return null;
}

export const desktopProcess = {
  resolveExecutable,
  async run(command: string, args: readonly string[], signal: AbortSignal, window: "hidden" | "visible") {
    const executable = await resolveExecutable(command);
    if (!executable) throw Object.assign(new Error("Desktop command is unavailable"), { code: "ENOENT" });
    signal.throwIfAborted();
    const env = modelShellEnvironment(process.env);
    for (const key of Object.keys(env)) if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete env[key];
    return execute(executable, [...args], { cwd: homedir(), env, signal, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
      windowsHide: window === "hidden" });
  },
};

export async function verifyDesktopPath(workspace: string, target: string, opening: boolean, language: UiLanguage, signal: AbortSignal) {
  const relative = workspaceRelativePath(workspace, target);
  const fail = (status: number, key: "target" | "fileType") => new WebRequestError(status, uiText(`web.desktop.${key}`, {}, language));
  let candidate = workspace;
  try {
    const pieces = relative ? relative.split("/") : [];
    for (const piece of pieces) {
      signal.throwIfAborted();
      if (process.platform === "win32" && /[ .]$/u.test(piece)) throw fail(403, "target");
      candidate = path.join(candidate, piece);
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw fail(403, "target");
    }
    const canonical = await realpath(candidate);
    if (normalizeWorkspacePath(canonical) !== normalizeWorkspacePath(candidate)) throw fail(403, "target");
    const info = await lstat(canonical);
    if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw fail(403, "target");
    const launcherExtension = /\.(?:app|application|bat|bin|cmd|com|cpl|desktop|dll|exe|hta|inf|ins|isp|jar|js|jse|ksh|lnk|msc|msi|msp|pif|ps1|ps1xml|ps2|psd1|psm1|reg|scf|scr|sct|sh|url|vb|vbe|vbs|website|ws|wsc|wsf|wsh)$/iu;
    const executable = info.isFile() && process.platform !== "win32" && Boolean(info.mode & 0o111);
    if (opening && (executable || launcherExtension.test(canonical))) {
      throw fail(403, "fileType");
    }
    signal.throwIfAborted();
    return canonical;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof WebRequestError) throw error;
    throw fail(404, "target");
  }
}
