import { ProcessCleanupError } from "../tools/process-completion.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runBash } from "../tools/bash.js";
import { createEffectiveSandboxPolicy } from "../tools/sandbox-policy.js";
import type { PermissionPolicy } from "../permissions/policy.js";
import type { TeamWorkspaceRecord } from "./workspace.js";
import { teamWorkspaceRoot, within, workspaceOwnershipFile } from "./workspace.js";
import { ToolFeedbackError } from "../tools/tool-feedback.js";

/** PowerShell can initialize at its drive root when ancestors are denied. Use a drive rooted at the owned workspace so provider traversal cannot reset cwd. */
export function isolatedCommand(command: string, workspace: string): string {
  if (process.platform !== "win32") return `cd -- '${workspace.replace(/'/gu, "'\''")}' && ${command}`;
  const quoted = `'${workspace.replace(/'/gu, "''")}'`;
  return `New-PSDrive -Name EPTEAM -PSProvider FileSystem -Root ${quoted} -Scope Global -ErrorAction Stop | Out-Null; Set-Location -LiteralPath 'EPTEAM:\\' -ErrorAction Stop; [System.Environment]::CurrentDirectory=${quoted}; ${command}`;
}

/** Payload-free model admission probe: no provider requests, always the fixed native backend. */
export async function verifyTeamIsolation(workspace: TeamWorkspaceRecord, policy: PermissionPolicy, signal?: AbortSignal): Promise<void> {
  const id = randomUUID();
  const sourceProbe = path.join(workspace.source, `.everpeace-team-denied-${id}`);
  const ownProbe = path.join(workspace.workspace, `.everpeace-team-probe-${id}`);
  const script = path.join(workspace.workspace, ".everpeace", `probe-${id}.cjs`);
  const siblingDirectory = path.join(teamWorkspaceRoot(), `probe-${id}`);
  const siblingProbe = path.join(siblingDirectory, "canary.txt");
  await fs.mkdir(siblingDirectory);
  await fs.writeFile(siblingProbe, "existing sibling isolation canary", { flag: "wx", mode: 0o600 });
  await fs.mkdir(path.dirname(script), { recursive: true });
  const payload = `const fs=require('node:fs'); const result={cwd:process.cwd().toLowerCase()===${JSON.stringify(workspace.workspace.toLowerCase())}}; try{fs.writeFileSync(${JSON.stringify(ownProbe)},'owned',{flag:'wx'});result.own=true}catch{result.own=false} try{fs.writeFileSync(${JSON.stringify(sourceProbe)},'denied',{flag:'wx'});result.sourceDenied=false}catch{result.sourceDenied=true} try{fs.readFileSync(${JSON.stringify(workspaceOwnershipFile(workspace.owner))});result.stateDenied=false}catch{result.stateDenied=true} try{fs.readFileSync(${JSON.stringify(path.join(workspace.commonGitDir, "config"))});result.gitDenied=false}catch{result.gitDenied=true} try{fs.readFileSync(${JSON.stringify(siblingProbe)});result.siblingReadDenied=false}catch{result.siblingReadDenied=true} try{fs.writeFileSync(${JSON.stringify(siblingProbe)},'changed');result.siblingWriteDenied=false}catch{result.siblingWriteDenied=true} fs.writeFileSync(${JSON.stringify(ownProbe)},JSON.stringify({...result,nonce:${JSON.stringify(id)}})); console.log(JSON.stringify(result)); if(!Object.values(result).every(Boolean))process.exitCode=1;`;
  await fs.writeFile(script, payload, { flag: "wx", mode: 0o600 });
  const quote = (value: string) => process.platform === "win32" ? `'${value.replace(/'/gu, "''")}'` : `'${value.replace(/'/gu, "'\''")}'`;
  try {
    const result = await runBash(isolatedCommand(`${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(script)}`, workspace.workspace), { cwd: workspace.workspace, streamOutput: false, timeoutMs: 30_000, ...(signal ? { signal } : {}), sandbox: { policy: createEffectiveSandboxPolicy(policy, workspace.workspace, [], { isolation: { deniedRoots: [workspace.source, teamWorkspaceRoot(), ...(within(workspace.source, workspace.commonGitDir) ? [] : [workspace.commonGitDir])], writableRoot: workspace.workspace, traversalRoots: [workspace.owner] } }) } });
    if (result.cleanupFailed) throw new ProcessCleanupError("Team sandbox probe cleanup failed");
    let evidence: Record<string, boolean> = {};
    try { const bytes = await fs.readFile(ownProbe, "utf8"); const value = JSON.parse(bytes) as Record<string, unknown>; if (value.nonce === id) evidence = value as Record<string, boolean>; } catch { /* A startup failure provides no host-owned, nonce-bound probe evidence. */ }
    const missing = ["cwd", "own", "sourceDenied", "stateDenied", "gitDenied", "siblingReadDenied", "siblingWriteDenied"].filter((key) => evidence[key] !== true);
    if (result.exitCode !== 0 || missing.length) {
      // Fixed categories and host-owned probe keys only; never forward backend output or exceptions.
      const category = /Operation not permitted|Permission denied/iu.test(result.stderr) ? "os_policy_refusal" : /bwrap:/u.test(result.stderr) ? "namespace_startup" : result.timedOut ? "timeout" : result.cancelled ? "cancelled" : "probe_incomplete";
      throw new ToolFeedbackError("SANDBOX_UNAVAILABLE", `Native isolation could not be proved; parallel coding member was not started (category=${category}, exit=${result.exitCode}, missing=${missing.join(",")}).`, "Inspect /doctor and use the root Agent or read-only members until this backend can enforce the team policy.");
    }
  } finally {
    // These names are host-generated, exclusive probe artifacts only.
    for (const file of [script, ownProbe, sourceProbe, siblingProbe]) {
      try { const stat = await fs.lstat(file); if (stat.isFile() && !stat.isSymbolicLink()) await fs.unlink(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await fs.rmdir(siblingDirectory);
  }
}
