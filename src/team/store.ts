import { applicationStateRoots } from "../tools/sandbox-policy.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeTeamOptions, parseTeamTask, type TeamSnapshot } from "./types.js";
import { sanitizeExecOutput } from "../cli/exec-output.js";
import { normalizeTokenUsageSample } from "../status/model-status.js";
import { redactSecretsPreservingLayout } from "../util/redact-secrets.js";

export class TeamStore {
  readonly directory: string;
  #queue = Promise.resolve();
  constructor(directory = path.join(applicationStateRoots().at(-1)!, "teams")) { this.directory = directory; }
  #file(id: string): string { if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error("Invalid team ID"); return path.join(this.directory, `${id}.json`); }
  save(snapshot: TeamSnapshot): Promise<void> {
    const text = redactSecretsPreservingLayout(JSON.stringify(snapshot));
    const destination = this.#file(snapshot.teamId);
    this.#queue = this.#queue.then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new Error("Team store must not be a link");
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, text, { flag: "wx", mode: 0o600 });
      try { await fs.rename(temporary, destination); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
    });
    return this.#queue;
  }
  async load(id: string, workspace: string, sessionId: string): Promise<TeamSnapshot> {
    const file = this.#file(id);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error("Invalid team record");
    const value = JSON.parse(await fs.readFile(file, "utf8")) as TeamSnapshot;
    if (!value || value.version !== 1 || value.teamId !== id || value.rootSessionId !== sessionId || typeof value.workspacePath !== "string" || path.resolve(value.workspacePath) !== path.resolve(workspace) || !Array.isArray(value.members) || value.members.length > 32 || !Array.isArray(value.usage?.attempts) || value.usage.attempts.length > 10_000 || !["default", "plan"].includes(value.mode) || !["running", "interrupted", "stopped", "finished"].includes(value.state) || !Number.isSafeInteger(value.openRequests) || value.openRequests < 0 || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0) throw new Error("Team record does not belong to this Session/workspace");
    value.options = normalizeTeamOptions(value.options);
    const identities = new Set<string>();
    for (const member of value.members) {
      if (!member || !/^[a-f0-9-]{36}$/u.test(member.agentId) || identities.has(member.agentId) || !/^[a-f0-9-]{36}$/u.test(member.taskId) || typeof member.modelId !== "string" || !["queued", "running", "completed", "failed", "cancelled", "interrupted", "integrated", "conflict"].includes(member.state) || member.workspacePath !== undefined && typeof member.workspacePath !== "string" || member.sessionId !== undefined && typeof member.sessionId !== "string") throw new Error("Invalid team member record");
      member.task = parseTeamTask(member.task); identities.add(member.agentId);
      if (member.errorCode !== undefined && member.errorCode !== "SANDBOX_UNAVAILABLE" && !['TEAM_SUBMODULE_UNSUPPORTED', 'TEAM_LFS_OBJECT_MISSING', 'TEAM_SNAPSHOT_INCOMPLETE', 'TEAM_SNAPSHOT_CHANGED', 'TEAM_RESOURCE_LIMIT'].includes(member.errorCode)) throw new Error("Invalid team member diagnostic code");
    }
    for (const member of value.members) if (member.task.dependencies.some((dependency) => !identities.has(dependency) || dependency === member.agentId)) throw new Error("Invalid persisted team dependencies");
    const visited = new Set<string>(); const stack = new Set<string>();
    const visit = (id: string): void => { if (stack.has(id)) throw new Error("Cyclic persisted team dependencies"); if (visited.has(id)) return; stack.add(id); for (const dependency of value.members.find((member) => member.agentId === id)!.task.dependencies) visit(dependency); stack.delete(id); visited.add(id); };
    for (const member of value.members) visit(member.agentId);
    const requests = new Set<number>();
    for (const attempt of value.usage.attempts) {
      if (!attempt || !Number.isSafeInteger(attempt.id) || attempt.id < 1 || requests.has(attempt.id) || !["coding", "summary", "title", "skill", "memory", "doctor", "benchmark"].includes(attempt.purpose) || !["completed", "failed", "cancelled", "rejected"].includes(attempt.status) || attempt.usage !== null && !normalizeTokenUsageSample(attempt.usage)) throw new Error("Invalid team request accounting");
      requests.add(attempt.id);
    }
    if ([value.usage.inputTokens, value.usage.outputTokens, value.usage.reasoningTokens].some((count) => !Number.isSafeInteger(count) || count < 0) || typeof value.usage.complete !== "boolean") throw new Error("Invalid team usage totals");
    const totals = value.usage.attempts.reduce((sum, attempt) => ({ input: sum.input + (attempt.usage?.input_tokens ?? 0), output: sum.output + (attempt.usage?.output_tokens ?? 0), reasoning: sum.reasoning + (attempt.usage?.reasoning_tokens ?? 0) }), { input: 0, output: 0, reasoning: 0 });
    if (totals.input !== value.usage.inputTokens || totals.output !== value.usage.outputTokens || totals.reasoning !== value.usage.reasoningTokens || value.usage.complete && value.usage.attempts.some((attempt) => attempt.usage === null)) throw new Error("Team usage totals do not match request evidence");
    if (value.inFlight !== undefined && (!Array.isArray(value.inFlight) || value.inFlight.length !== value.openRequests || value.inFlight.some((request) => !request || !Number.isSafeInteger(request.id) || request.id < 1 || requests.has(request.id) || !["coding", "summary", "title", "skill", "memory", "doctor", "benchmark"].includes(request.purpose) || typeof request.agentId !== "string" || typeof request.modelId !== "string"))) throw new Error("Invalid in-flight team requests");
    if (value.openRequests > 0) { value.usage.complete = false; value.usage.attempts = [...value.usage.attempts, ...(value.inFlight ?? []).map((request) => ({ ...request, status: "cancelled" as const, usage: null }))]; }
    value.openRequests = 0; value.inFlight = [];
    if (value.state === "running") value.state = "interrupted";
    for (const member of value.members) if (member.state === "running" || member.state === "queued") member.state = "interrupted";
    return {
      version: 1, teamId: value.teamId, rootSessionId: value.rootSessionId, workspacePath: value.workspacePath,
      mode: value.mode, state: value.state, options: value.options, openRequests: 0, inFlight: [], startedAt: value.startedAt, elapsedMs: value.elapsedMs,
      ...(value.modelBindings && typeof value.modelBindings === "object" && ["root", "explorer", "worker", "reviewer"].every((role) => /^[a-f0-9]{64}$/u.test(value.modelBindings![role] ?? "")) ? { modelBindings: Object.fromEntries(["root", "explorer", "worker", "reviewer"].map((role) => [role, value.modelBindings![role]!])) } : {}),
      ...(value.goalAccounting && typeof value.goalAccounting.goalId === "string" && Number.isSafeInteger(value.goalAccounting.initialTokensUsed) && value.goalAccounting.initialTokensUsed >= 0 && typeof value.goalAccounting.initialUsageComplete === "boolean" ? { goalAccounting: { ...value.goalAccounting } } : {}),
      usage: { ...(Number.isSafeInteger(value.usage.tokenBudget) && value.usage.tokenBudget! >= 0 ? { tokenBudget: value.usage.tokenBudget } : {}), attempts: value.usage.attempts.map(({ id, purpose, status, usage, agentId, modelId }) => ({ id, purpose, status, usage: usage === null ? null : normalizeTokenUsageSample(usage)!, ...(typeof agentId === "string" ? { agentId } : {}), ...(typeof modelId === "string" ? { modelId } : {}) })), inputTokens: value.usage.inputTokens, outputTokens: value.usage.outputTokens, reasoningTokens: value.usage.reasoningTokens, complete: value.usage.complete },
      members: value.members.map((member) => ({ agentId: member.agentId, taskId: member.taskId, modelId: member.modelId, task: member.task, state: member.state,
        ...(typeof member.integrationEligible === "boolean" ? { integrationEligible: member.integrationEligible } : {}),
        ...(member.artifactHashes && typeof member.artifactHashes === "object" && !Array.isArray(member.artifactHashes) && Object.values(member.artifactHashes).every((hash) => hash === null || typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash)) ? { artifactHashes: { ...member.artifactHashes } } : {}),
        ...(member.sessionId ? { sessionId: member.sessionId } : {}), ...(member.workspacePath ? { workspacePath: member.workspacePath } : {}), ...(typeof member.sessionWorkspacePath === "string" ? { sessionWorkspacePath: member.sessionWorkspacePath } : {}),
        ...(typeof member.summary === "string" ? { summary: sanitizeExecOutput(member.summary, 16 * 1024) } : {}),
        ...(typeof member.error === "string" ? { error: sanitizeExecOutput(member.error, 4096) } : {}),
        ...(typeof member.verification === "string" ? { verification: sanitizeExecOutput(member.verification, 4096) } : {}),
        ...(typeof member.integrationId === "string" && /^[a-f0-9-]{36}$/u.test(member.integrationId) ? { integrationId: member.integrationId } : {}),
        ...(Array.isArray(member.changedPaths) && member.changedPaths.every((file) => typeof file === "string" && file.length <= 2048) ? { changedPaths: member.changedPaths.slice(0, 10_000) } : {}),
      })),
    };
  }
  async claim(id: string): Promise<() => Promise<void>> {
    await fs.mkdir(this.directory, { recursive: true });
    if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new Error("Team store must not be a link");
    const file = `${this.#file(id)}.lock`; const nonce = randomUUID(); const contents = JSON.stringify({ pid: process.pid, nonce });
    try { await fs.writeFile(file, contents, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error("Invalid team ownership lock");
      const previous = await fs.readFile(file, "utf8"); const owner = JSON.parse(previous) as { pid: number };
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error("Invalid team ownership lock");
      try { process.kill(owner.pid, 0); throw new Error("Team is still owned by a live process"); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw failure; }
      if (await fs.readFile(file, "utf8") !== previous) throw new Error("Team ownership changed during recovery");
      await fs.unlink(file); await fs.writeFile(file, contents, { flag: "wx", mode: 0o600 });
    }
    return async () => { if (await fs.readFile(file, "utf8") !== contents) throw new Error("Team ownership changed before cleanup"); await fs.unlink(file); };
  }
}

export class TeamConfigStore {
  readonly file: string;
  constructor(file = path.join(applicationStateRoots()[0]!, "team.json")) { this.file = file; }
  async load(): Promise<import("./types.js").TeamOptions> {
    try { const { normalizeTeamOptions } = await import("./types.js"); const stat = await fs.lstat(this.file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error("Invalid team configuration"); return normalizeTeamOptions(JSON.parse(await fs.readFile(this.file, "utf8")) as import("./types.js").TeamOptions); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false }; throw error; }
  }
  async save(config: import("./types.js").TeamOptions): Promise<void> {
    const { normalizeTeamOptions } = await import("./types.js");
    const { resumeTeamId: _resume, ...value } = normalizeTeamOptions(config);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    try { await fs.rename(temporary, this.file); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  }
}
