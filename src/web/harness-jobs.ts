import { stripVTControlCharacters } from "node:util";
import { uiText } from "../localization/messages.js";
import type { UiLanguage } from "../localization/language.js";
import type { BashOutputChunk } from "../tools/bash.js";
import { backgroundJobLimits, type BackgroundJobObserver } from "../tools/background-jobs.js";
import { redactSecretsPreservingLayout } from "../util/redact-secrets.js";

type Channel = Parameters<BashOutputChunk>[0];
type Status = "running" | "stopping" | "completed" | "killed" | "failed";
type Publish = (frame: unknown) => void;

const lineLimit = 16 * 1024;
const frameLimit = 64 * 1024;
const retentionBytes = 256 * 1024;
const retentionChunks = 1_024;
const credential = /["']?(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|password|passwd|secret|private[_ -]?key)["']?\s*[:=]\s*(.*)$/iu;
const privateKeyStart = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/iu;
const privateKeyEnd = /-----END [A-Z ]*PRIVATE KEY-----/iu;

/** Redact complete lines before assigning offsets. A read can never see a partial token. */
class OutputLines {
  #pending = "";
  #unclassified = false;
  #secret: 'pem' | 'value' | '"' | "'" | undefined;

  constructor(private readonly append: (text: string, gap?: true) => void) {}

  push(text: string): void {
    if (this.#unclassified) return;
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const part = lines[index]!;
      if (this.#pending.length + part.length > lineLimit) {
        // A clipped line could leave an unknown multiline credential open.
        this.#pending = "";
        this.#unclassified = true;
        this.append("\n", true);
        return;
      }
      this.#pending += part;
      if (index < lines.length - 1) this.#complete("\n");
    }
  }

  finish(): void {
    if (this.#pending) this.#complete("");
  }

  #complete(suffix: string): void {
    const raw = this.#pending;
    this.#pending = "";
    // oxlint-disable-next-line no-control-regex -- Background output is displayed as inert text in a browser terminal block.
    const line = stripVTControlCharacters(raw).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
    this.append(this.#redact(line) + suffix);
  }

  #redact(line: string): string {
    if (this.#secret === 'pem' || privateKeyStart.test(line)) {
      this.#secret = privateKeyEnd.test(line) ? undefined : 'pem';
      return "[private key redacted]";
    }
    const openQuote = (value: string) => {
      const quote = value[0];
      return (quote === '"' || quote === "'") && !value.slice(1).replace(/\\./gu, "").includes(quote) ? quote : undefined;
    };
    if (this.#secret === '"' || this.#secret === "'") {
      if (line.replace(/\\./gu, "").includes(this.#secret)) this.#secret = undefined;
      return "[secret redacted]";
    }
    if (this.#secret === 'value') {
      if (line.trim()) this.#secret = openQuote(line.trimStart());
      return "[secret redacted]";
    }
    const assignment = credential.exec(line);
    const value = assignment?.[1];
    if (value === "" || /\bBearer\s*$/iu.test(line)) this.#secret = 'value';
    if (value) {
      this.#secret = openQuote(value);
      if (this.#secret) return "[secret redacted]";
    }
    return redactSecretsPreservingLayout(line);
  }
}

interface OutputChunk {
  at: number;
  bytes: Buffer;
  channel: Channel;
  gapBefore?: true;
}

class JobOutput {
  readonly #chunks: OutputChunk[] = [];
  readonly #stdout = new OutputLines((text, gap) => this.#append("stdout", text, gap));
  readonly #stderr = new OutputLines((text, gap) => this.#append("stderr", text, gap));
  total = 0;

  get earliest() { return this.#chunks[0]?.at ?? this.total; }

  push(channel: Channel, text: string) { (channel === "stdout" ? this.#stdout : this.#stderr).push(text); }
  finish() { this.#stdout.finish(); this.#stderr.finish(); }

  #append(channel: Channel, text: string, gapBefore?: true): void {
    if (!text) return;
    const bytes = Buffer.from(text);
    this.#chunks.push({ at: this.total, bytes, channel, ...(gapBefore ? { gapBefore } : {}) });
    this.total += bytes.length;
    while (this.#chunks.length > retentionChunks || this.total - this.earliest > retentionBytes) this.#chunks.shift();
  }

  read(from: number, write: Publish): number {
    let next = Math.max(from, this.earliest);
    let lossy = next !== from;
    let chunks: Array<{ at: number; text: string; channel: Channel; gapBefore?: true }> = [];
    let bytes = 0;
    const flush = () => {
      if (chunks.length || lossy) write({ type: "output", chunks, next, ...(lossy ? { lossy: true } : {}) });
      chunks = [];
      bytes = 0;
      lossy = false;
    };
    for (const chunk of this.#chunks) {
      if (chunk.at + chunk.bytes.length <= next) continue;
      let offset = Math.max(0, next - chunk.at);
      while (offset < chunk.bytes.length && (chunk.bytes[offset]! & 0xc0) === 0x80) offset++;
      lossy ||= next < chunk.at + offset;
      const slice = chunk.bytes.subarray(offset);
      if (bytes && bytes + slice.length > frameLimit) flush();
      next = chunk.at + chunk.bytes.length;
      if (!slice.length) continue;
      chunks.push({ at: chunk.at + offset, text: slice.toString("utf8"), channel: chunk.channel,
        ...(chunk.gapBefore ? { gapBefore: true } : {}) });
      bytes += slice.length;
    }
    flush();
    return next;
  }
}

interface JobRow {
  id: string;
  owner: string;
  kind: "bash";
  label: string;
  status: Status;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  detail?: string;
}

interface Job {
  row: JobRow;
  output: JobOutput;
  requestStop?: () => boolean;
}

function rowView(job: Job) {
  return { ...job.row, output: { total: job.output.total, earliest: job.output.earliest } };
}

type JobListener = (job: Job, lifecycle: boolean) => void;

/** Browser projections of task-owned jobs. This registry never spawns a process. */
export class HarnessJobs {
  readonly #jobs = new Map<string, Job>();
  readonly #listeners = new Set<JobListener>();

  constructor(private readonly language: UiLanguage) {}

  observer(sessionId: () => string | null): BackgroundJobObserver {
    return {
      started: ({ job_id: id, command, started_at }, requestStop) => {
        const owner = sessionId();
        if (!owner) return;
        const label = redactSecretsPreservingLayout(stripVTControlCharacters(command)).split(/\s+/u).join(" ").trim().slice(0, 512);
        const job: Job = { row: { id, owner, label, kind: "bash", status: "running", startedAt: Date.parse(started_at) }, output: new JobOutput(), requestStop };
        this.#jobs.set(id, job);
        this.#notify(job, true);
      },
      output: (id, channel, text) => {
        const job = this.#jobs.get(id);
        if (!job?.requestStop) return;
        const before = job.output.total;
        job.output.push(channel, text);
        if (job.output.total !== before) this.#notify(job, false);
      },
      stopping: id => {
        const job = this.#jobs.get(id);
        if (!job?.requestStop) return;
        job.row.status = "stopping";
        this.#notify(job, true);
      },
      settled: (completion, cleanupFailed) => {
        const job = this.#jobs.get(completion.job_id);
        if (!job) return;
        const { exit_code: exitCode, status, finished_at } = completion;
        job.output.finish();
        delete job.requestStop;
        job.row.finishedAt = Date.parse(finished_at);
        if (exitCode !== null) job.row.exitCode = exitCode;
        if (cleanupFailed || status === "timed_out") {
          job.row.status = "failed";
          job.row.detail = uiText(cleanupFailed ? "web.job.cleanupFailed" : "web.job.timedOut", {}, this.language);
        } else if (status === "cancelled") job.row.status = "killed";
        else job.row.status = status === "completed" || exitCode !== null ? "completed" : "failed";
        const finished = [...this.#jobs.values()].filter(item => !item.requestStop);
        for (const expired of finished.slice(0, Math.max(0, finished.length - backgroundJobLimits.maxRetainedJobs))) {
          this.#jobs.delete(expired.row.id);
          if (expired.row.owner !== job.row.owner) this.#notify(expired, true);
        }
        this.#notify(job, true);
      },
    };
  }

  get(owner: string, jobId: string): Job | undefined {
    const job = this.#jobs.get(jobId);
    return job?.row.owner === owner ? job : undefined;
  }

  #notify(job: Job, lifecycle: boolean): void {
    for (const listener of this.#listeners) listener(job, lifecycle);
  }

  rows(owner: string, write: Publish): () => void {
    const publish = () => write({ type: "rows", jobs: [...this.#jobs.values()].filter(job => job.row.owner === owner).map(rowView) });
    const listener: JobListener = (job, lifecycle) => { if (lifecycle && job.row.owner === owner) publish(); };
    this.#listeners.add(listener);
    publish();
    return () => { this.#listeners.delete(listener); };
  }

  follow(job: Job, from: number | undefined, write: Publish, finish: () => void): () => void {
    let cursor = from ?? job.output.earliest;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = () => { this.#listeners.delete(listener); clearTimeout(timer); };
    const publish = () => {
      timer = undefined;
      cursor = job.output.read(cursor, write);
      if (!job.requestStop) {
        write({ type: "status", job: rowView(job) });
        close();
        finish();
      }
    };
    const listener: JobListener = changed => {
      if (changed === job && timer === undefined) timer = setTimeout(publish, 75);
    };
    this.#listeners.add(listener);
    write({ type: "opened", job: rowView(job), from: cursor });
    publish();
    return close;
  }
}
