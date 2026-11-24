import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface HarnessScheduleHost {
  hasSession(id: string): boolean;
  startSession(id: string, prompt: string): void;
  enqueueSession?(id: string, prompt: string): Promise<void>;
}

type ScheduleTarget = { kind: "session"; sessionId: string };
type ScheduleStatus = "active" | "paused" | "ended";
export interface ScheduleTask {
  id: string;
  kind: "after" | "at" | "every";
  title: string;
  prompt: string;
  scheduledAt: string;
  target: ScheduleTarget;
  involvedSessionIds: string[];
  status: ScheduleStatus;
  createdAt: string;
  updatedAt: string;
  afterSeconds?: number;
  everySeconds?: number;
  lastDelivery?: { scheduledAt: string; deliveredAt: string; messageId: string; targetSessionId: string };
}

const maxTasks = 128;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function taskValid(value: unknown): value is ScheduleTask {
  if (!record(value) || typeof value.id !== "string" || typeof value.title !== "string" || typeof value.prompt !== "string" ||
    !["after", "at", "every"].includes(String(value.kind)) || typeof value.scheduledAt !== "string" ||
    !record(value.target) || value.target.kind !== "session" || typeof value.target.sessionId !== "string" ||
    !Array.isArray(value.involvedSessionIds) || !value.involvedSessionIds.every(item => typeof item === "string") ||
    !["active", "paused", "ended"].includes(String(value.status)) || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return false;
  if (value.kind === "after" && (typeof value.afterSeconds !== "number" || !Number.isSafeInteger(value.afterSeconds) || value.afterSeconds < 1)) return false;
  if (value.kind === "every" && (typeof value.everySeconds !== "number" || !Number.isSafeInteger(value.everySeconds) || value.everySeconds < 1)) return false;
  return value.title.length <= 120 && value.prompt.length <= 64_000;
}

function isTasks(value: unknown): value is ScheduleTask[] {
  return Array.isArray(value) && value.length <= maxTasks && value.every(taskValid);
}

export class HarnessSchedule {
  readonly #file: string;
  readonly #host: HarnessScheduleHost;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #tasks: ScheduleTask[] = [];
  #loaded = false;

  constructor(host: HarnessScheduleHost, directory: string, workspace: string) {
    this.#host = host;
    const identity = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
    this.#file = path.join(directory, `browser-schedule-${identity}.json`);
  }

  async initialize(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.#file, "utf8"));
      if (isTasks(value)) this.#tasks = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#tasks = [];
    }
    for (const task of this.#tasks) this.#arm(task);
  }

  async catalog(): Promise<ScheduleTask[]> { await this.initialize(); return this.#tasks.map(task => structuredClone(task)); }

  async list(request: Record<string, unknown>): Promise<{ items: ScheduleTask[]; total: number }> {
    const rows = await this.catalog();
    const active = request.active;
    const filtered = typeof active === "boolean" ? rows.filter(task => active ? task.status === "active" : task.status !== "active") : rows;
    const offset = typeof request.offset === "number" && Number.isSafeInteger(request.offset) && request.offset >= 0 ? request.offset : 0;
    const limit = typeof request.limit === "number" && Number.isSafeInteger(request.limit) && request.limit > 0 ? Math.min(request.limit, 500) : 100;
    return { items: filtered.slice(offset, offset + limit), total: filtered.length };
  }

  async create(request: Record<string, unknown>): Promise<ScheduleTask> {
    await this.initialize();
    if (this.#tasks.length >= maxTasks || typeof request.title !== "string" || !request.title.trim() || request.title.length > 120 ||
      typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 64_000) throw new Error("Invalid automation task");
    const sessionId = record(request.target) && request.target.kind === "session" && typeof request.target.sessionId === "string"
      ? request.target.sessionId : typeof request.sessionId === "string" ? request.sessionId : undefined;
    if (!sessionId || !this.#host.hasSession(sessionId)) throw new Error("Automation task target Session is unavailable");
    const timing = record(request.timing) ? request.timing : request;
    const kind = timing.kind === "every" ? "every" : timing.kind === "at" ? "at" : "after";
    const now = new Date();
    let scheduledAt = now;
    let afterSeconds: number | undefined;
    let everySeconds: number | undefined;
    if (kind === "after") {
      afterSeconds = typeof timing.after_seconds === "number" && Number.isSafeInteger(timing.after_seconds) ? timing.after_seconds : 60;
      if (afterSeconds < 1 || afterSeconds > 31_536_000) throw new Error("Invalid automation delay");
      scheduledAt = new Date(now.getTime() + afterSeconds * 1000);
    } else if (kind === "every") {
      everySeconds = typeof timing.every_seconds === "number" && Number.isSafeInteger(timing.every_seconds) ? timing.every_seconds : 60;
      if (everySeconds < 1 || everySeconds > 31_536_000) throw new Error("Invalid automation interval");
      scheduledAt = new Date(now.getTime() + everySeconds * 1000);
    } else {
      const at = timing.at;
      const parsed = typeof at === "string" ? Date.parse(at) : record(at) && typeof at.date === "string" && typeof at.time === "string" ? Date.parse(`${at.date}T${at.time}`) : NaN;
      if (!Number.isFinite(parsed) || parsed <= Date.now()) throw new Error("Invalid automation time");
      scheduledAt = new Date(parsed);
    }
    const timestamp = now.toISOString();
    const task: ScheduleTask = { id: randomUUID(), kind, title: request.title.trim(), prompt: request.prompt.trim(), scheduledAt: scheduledAt.toISOString(),
      target: { kind: "session", sessionId }, involvedSessionIds: [sessionId], status: "active", createdAt: timestamp, updatedAt: timestamp,
      ...(afterSeconds === undefined ? {} : { afterSeconds }), ...(everySeconds === undefined ? {} : { everySeconds }) };
    this.#tasks.push(task);
    await this.#save();
    this.#arm(task);
    return structuredClone(task);
  }

  async view(id: string): Promise<ScheduleTask> {
    await this.initialize();
    const task = this.#tasks.find(row => row.id === id);
    if (!task) throw new Error("Automation task is unavailable");
    return structuredClone(task);
  }

  async edit(request: Record<string, unknown>): Promise<ScheduleTask | { deleted: true }> {
    await this.initialize();
    const id = typeof request.id === "string" ? request.id : "";
    const index = this.#tasks.findIndex(task => task.id === id);
    if (index < 0) throw new Error("Automation task is unavailable");
    const task = this.#tasks[index]!;
    if (request.action === "delete") {
      task.status = "ended"; task.updatedAt = new Date().toISOString(); this.#clear(task.id); await this.#save(); return { deleted: true };
    }
    const patch = record(request.patch) ? request.patch : request;
    if (typeof patch.title === "string" && patch.title.trim()) task.title = patch.title.trim().slice(0, 120);
    if (typeof patch.prompt === "string" && patch.prompt.trim()) task.prompt = patch.prompt.trim().slice(0, 64_000);
    if (patch.status === "paused" || patch.status === "active") task.status = patch.status;
    task.updatedAt = new Date().toISOString();
    if (task.status === "active") this.#arm(task); else this.#clear(task.id);
    await this.#save();
    return structuredClone(task);
  }

  async run(id: string): Promise<ScheduleTask> {
    await this.initialize();
    const task = this.#tasks.find(row => row.id === id);
    if (!task) throw new Error("Automation task is unavailable");
    await this.#deliver(task, task.scheduledAt);
    return this.view(id);
  }

  async deleteInactive(): Promise<{ deleted: number }> {
    await this.initialize();
    const before = this.#tasks.length;
    this.#tasks = this.#tasks.filter(task => task.status === "active");
    await this.#save();
    return { deleted: before - this.#tasks.length };
  }

  close(): void { for (const timer of this.#timers.values()) clearTimeout(timer); this.#timers.clear(); }

  #clear(id: string): void { const timer = this.#timers.get(id); if (timer) clearTimeout(timer); this.#timers.delete(id); }
  #arm(task: ScheduleTask): void {
    this.#clear(task.id);
    if (task.status !== "active") return;
    const delay = Math.max(1, Math.min(Date.parse(task.scheduledAt) - Date.now(), 2_147_000_000));
    this.#timers.set(task.id, setTimeout(() => void this.#deliver(task, task.scheduledAt), delay));
  }
  async #deliver(task: ScheduleTask, scheduledAt: string): Promise<void> {
    if (task.status !== "active" || !this.#host.hasSession(task.target.sessionId)) { task.status = "ended"; await this.#save(); return; }
    try { this.#host.startSession(task.target.sessionId, task.prompt); }
    catch {
      if (this.#host.enqueueSession) {
        await this.#host.enqueueSession(task.target.sessionId, task.prompt);
        const deliveredAt = new Date().toISOString();
        task.lastDelivery = { scheduledAt, deliveredAt, messageId: randomUUID(), targetSessionId: task.target.sessionId };
        if (task.kind === "every" && task.everySeconds) task.scheduledAt = new Date(Date.now() + task.everySeconds * 1000).toISOString();
        else task.status = "ended";
        task.updatedAt = deliveredAt;
        await this.#save();
        if (task.status === "active") this.#arm(task); else this.#clear(task.id);
        return;
      }
      // A target Session may still be finishing an earlier turn. Keep the task active and retry shortly.
      task.scheduledAt = new Date(Date.now() + 1_000).toISOString();
      task.updatedAt = new Date().toISOString();
      await this.#save();
      this.#arm(task);
      return;
    }
    const deliveredAt = new Date().toISOString();
    task.lastDelivery = { scheduledAt, deliveredAt, messageId: randomUUID(), targetSessionId: task.target.sessionId };
    if (task.kind === "every" && task.everySeconds) task.scheduledAt = new Date(Date.now() + task.everySeconds * 1000).toISOString();
    else task.status = "ended";
    task.updatedAt = deliveredAt;
    await this.#save();
    if (task.status === "active") this.#arm(task); else this.#clear(task.id);
  }
  async #save(): Promise<void> {
    await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.tmp-${randomUUID()}`;
    try { await fs.writeFile(temporary, JSON.stringify(this.#tasks) + "\n", { flag: "wx", mode: 0o600 }); await fs.rename(temporary, this.#file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
}
