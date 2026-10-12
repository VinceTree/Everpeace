import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { UserSettingsStore } from "./user-settings.js";
import { SessionStore } from "./session-store.js";
import { scanSensitiveText } from "../util/sensitive-scan.js";
import { redactSecretsPreservingLayout } from "../util/redact-secrets.js";
import { stripVTControlCharacters } from "node:util";
import { defaultRegistryPath } from './model-registry.js';
import { defaultMemoryDirectory } from '../memory/learned-memory.js';
import { readToolOutputReferences } from './session-outputs.js';

interface PrivacySettings { version: 1; retentionDays: number | null; lastCleanupDay?: string }
export interface CleanupPreview { version: 1; token: string; at: string; directoryDigest: string; retentionDays: number | null; candidates: Array<{ id: string; fingerprint: string; bytes: number }>; excluded: Array<{ id: string; reason: string }>; invalidRecords: number }
const daysValid = (value: unknown): value is number | null => value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 36_500;
function validSettings(value: unknown): value is PrivacySettings {
  return value !== null && typeof value === "object" && "version" in value && value.version === 1 && "retentionDays" in value && daysValid(value.retentionDays)
    && (!("lastCleanupDay" in value) || typeof value.lastCleanupDay === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value.lastCleanupDay));
}
function validPreview(value: unknown): value is CleanupPreview {
  if (!value || typeof value !== "object") return false;
  const v = value as CleanupPreview;
  return v.version === 1 && typeof v.token === "string" && /^[a-f0-9]{64}$/u.test(v.token) && typeof v.at === "string" && Number.isFinite(Date.parse(v.at)) && typeof v.directoryDigest === "string" && daysValid(v.retentionDays)
    && Array.isArray(v.candidates) && v.candidates.length <= 10_000 && v.candidates.every((c) => c && typeof c.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/u.test(c.id) && typeof c.fingerprint === "string" && typeof c.bytes === "number" && Number.isSafeInteger(c.bytes) && c.bytes >= 0)
    && Array.isArray(v.excluded) && v.excluded.length <= 10_000 && v.excluded.every((e) => e && typeof e.id === "string" && typeof e.reason === "string") && Number.isSafeInteger(v.invalidRecords) && v.invalidRecords >= 0;
}
export class SessionPrivacy {
  readonly settings: UserSettingsStore<PrivacySettings>;
  readonly #preview: UserSettingsStore<{ version: 1; preview?: CleanupPreview }>;
  constructor(readonly store: SessionStore, settingsPath?: string, readonly now: () => Date = () => new Date()) {
    this.settings = new UserSettingsStore("privacy.json", validSettings, () => ({ version: 1, retentionDays: null }), settingsPath);
    this.#preview = new UserSettingsStore("privacy-preview.json", (v): v is { version: 1; preview?: CleanupPreview } => v !== null && typeof v === "object" && "version" in v && v.version === 1 && (!("preview" in v) || validPreview(v.preview)), () => ({ version: 1 }), `${this.settings.path}.preview`);
  }
  #directoryDigest(): string { return createHash("sha256").update(path.resolve(this.store.directory)).digest("hex"); }
  async preview(retentionDays: number | null, persist = true): Promise<CleanupPreview> {
    if (!daysValid(retentionDays)) throw new Error("Retention must be 1–36500 days or forever");
    const { sessions, skipped } = await this.store.list();
    if (sessions.length > 10_000) throw new Error("Too many sessions for one cleanup preview");
    const result: CleanupPreview = { version: 1, token: "", at: this.now().toISOString(), directoryDigest: this.#directoryDigest(), retentionDays, candidates: [], excluded: [], invalidRecords: skipped };
    const cutoff = retentionDays === null ? -Infinity : this.now().getTime() - retentionDays * 86_400_000;
    for (const session of sessions) {
      let reason: string | undefined;
      if (retentionDays === null || Date.parse(session.updated_at) >= cutoff || !Number.isFinite(Date.parse(session.updated_at))) reason = "retained_by_policy";
      else if (session.team || await this.store.activity.hasRetainedTeam(session.id)) reason = "retained_team_ownership";
      else {
        const activity = await this.store.activity.inspect(session.id);
        if (activity !== "closed") reason = activity === "active" ? "active_session" : "ownership_unknown";
      }
      if (reason) { result.excluded.push({ id: session.id, reason }); continue; }
      try {
        const stat = await fs.lstat(path.join(this.store.directory, `${session.id}.jsonl`));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe Session file");
        result.candidates.push({ id: session.id, bytes: stat.size, fingerprint: `${session.updated_at}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` });
      } catch { result.excluded.push({ id: session.id, reason: "unreadable_or_changed" }); }
    }
    result.token = createHash("sha256").update(JSON.stringify(result)).update(randomUUID()).digest("hex");
    if (persist) await this.#preview.update(() => ({ version: 1, preview: result }));
    return result;
  }
  async #consume(token: string): Promise<CleanupPreview> {
    let preview: CleanupPreview | undefined;
    await this.#preview.update((current) => {
      const value = current.preview;
      if (!value || value.token !== token || value.directoryDigest !== this.#directoryDigest() || this.now().getTime() - Date.parse(value.at) > 10 * 60_000 || Date.parse(value.at) > this.now().getTime()) throw new Error("Privacy preview expired or changed; preview again");
      preview = value; return { version: 1 };
    });
    return preview!;
  }
  async configure(token: string): Promise<void> {
    const preview = await this.#consume(token);
    const currentPreview = await this.preview(preview.retentionDays, false);
    if (JSON.stringify([preview.candidates, preview.excluded, preview.invalidRecords]) !== JSON.stringify([currentPreview.candidates, currentPreview.excluded, currentPreview.invalidRecords])) throw new Error("Session cleanup preview changed; preview again");
    await this.settings.update((current) => ({ ...current, retentionDays: preview.retentionDays }));
  }
  async cleanup(token: string): Promise<{ deleted: number; failed: number; excluded: number }> {
    const preview = await this.#consume(token);
    const current = await this.settings.read();
    if (current.retentionDays !== preview.retentionDays) throw new Error("Retention policy changed; preview again");
    return this.#deletePreview(preview);
  }
  async #deletePreview(preview: CleanupPreview): Promise<{ deleted: number; failed: number; excluded: number }> {
    const current = await this.settings.read();
    if (current.retentionDays !== preview.retentionDays) throw new Error("Retention policy changed; preview again");
    let deleted = 0; let failed = 0;
    for (const candidate of preview.candidates) {
      try { await this.store.deleteMany([candidate.id], { [candidate.id]: candidate.fingerprint }); deleted++; }
      catch { failed++; }
    }
    return { deleted, failed, excluded: preview.excluded.length + preview.invalidRecords };
  }
  async autoCleanup(): Promise<{ deleted: number; failed: number; excluded: number } | undefined> {
    const day = this.now().toISOString().slice(0, 10); let claimed = false; let retentionDays: number | null = null;
    await this.settings.update((current) => {
      if (current.retentionDays === null || current.lastCleanupDay === day) return current;
      claimed = true; retentionDays = current.retentionDays; return { ...current, lastCleanupDay: day };
    });
    if (!claimed) return;
    const preview = await this.preview(retentionDays, false); return this.#deletePreview(preview);
  }
  async scan(sessionId: string): Promise<{ rules: Record<string, number>; findings: number; complete: boolean }> {
    const session = await this.store.load(sessionId); const rules: Record<string, number> = {}; let findings = 0;
    let complete = true; let remaining = 16 * 1024 * 1024;
    const texts = [...session.timeline.flatMap((entry) => "text" in entry ? [entry.text] : []), ...session.context.map((item) => JSON.stringify(item))];
    const attachments = await readToolOutputReferences(path.join(this.store.directory, `${sessionId}.jsonl`), sessionId);
    if (!attachments.safeToClean) complete = false;
    for (const reference of attachments.references) { const attachment = await this.store.readToolOutput(sessionId, reference.output_id); if (attachment) {texts.push(attachment.bytes.toString('utf8')); if (attachment.bytes.byteLength < reference.original_bytes) complete = false;} else complete = false; }
    for (const value of texts) {
      if (remaining <= 0 || findings >= 10_000) { complete = false; break; }
      const bounded = value.slice(0, Math.min(remaining, 1024 * 1024)); remaining -= bounded.length;
      if (bounded.length < value.length) complete = false;
      const matches = scanSensitiveText(bounded); if (matches.length >= 1000) complete = false;
      for (const finding of matches) { rules[finding.rule] = (rules[finding.rule] ?? 0) + 1; findings++; }
    }
    return { rules, findings, complete };
  }
  async previewExport(sessionId: string): Promise<{ fingerprint: string; text: string }> {
    const loaded = await this.store.load(sessionId);
    return { fingerprint: createHash("sha256").update(JSON.stringify(loaded)).digest("hex"), text: redactSecretsPreservingLayout(stripVTControlCharacters(loaded.timeline.filter((entry) => entry.kind === "user" || entry.kind === "assistant").flatMap((entry) => "text" in entry ? [entry.text] : []).join("\n"))).slice(0, 12_000) };
  }
  async export(sessionId: string, targetPath: string, includeConversation = false, previewFingerprint?: string): Promise<void> {
    const loaded = await this.store.load(sessionId);
    if (includeConversation && (!previewFingerprint || previewFingerprint !== createHash("sha256").update(JSON.stringify(loaded)).digest("hex"))) throw new Error("Conversation changed; preview again");
    const value = {
      schema: 1, kind: includeConversation ? "redacted_conversation" : "diagnostic_summary",
      usage: { inputTokens: loaded.usage.input_tokens, outputTokens: loaded.usage.output_tokens, complete: loaded.usage.complete },
      ...(loaded.performanceReport ? { performance: loaded.performanceReport } : {}),
      ...(loaded.summary.workflow ? { verification: loaded.summary.workflow.last_verification_suite?.evidence ? { ...loaded.summary.workflow.last_verification_suite.evidence, workspaceRevision: undefined, reportDigests: [] } : { state: "unknown" } } : {}),
      ...(includeConversation ? { conversation: loaded.timeline.filter((entry) => entry.kind === "user" || entry.kind === "assistant").flatMap((entry) => "text" in entry ? [{ kind: entry.kind, text: redactSecretsPreservingLayout(stripVTControlCharacters(entry.text)) }] : []), notice: "Redaction cannot identify all business data. Attachments and reasoning are excluded." } : {}),
    };
    const requested = path.resolve(targetPath);
    let current = path.parse(requested).root;
    for (const part of path.relative(current, path.dirname(requested)).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Export destination must not traverse symbolic links");
    }
    // Windows short names and casing can differ without being a link.
    const parent = await fs.realpath(path.dirname(requested));
    const target = path.join(parent, path.basename(requested));
    const temporary = path.join(parent, `.everpeace-export-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      // Linking a completed file atomically refuses both existing files and links.
      await fs.link(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async describe(): Promise<string> {
    const settings = await this.settings.read();
    const config = path.dirname(defaultRegistryPath());
    return [`Session storage: ${this.store.directory}`, `Tool attachments: ${path.join(this.store.directory,'outputs')} (owned by their Session)`, `Retention: ${settings.retentionDays === null ? "forever (default)" : settings.retentionDays + " days since last persisted activity"}`, `Privacy policy: ${this.settings.path}`, `Learned Memory: ${defaultMemoryDirectory()} (project entries: 90 days; user entries: until reviewed or removed; /memory inspect, disable, delete or clear)`, `Model registry: ${defaultRegistryPath()} (metadata until model removal)`, 'Credentials: operating-system Keyring, service Everpeace; remove using everpeace logout', `Input history: ${path.join(config,'input-history.json')} (separate retention; remove this file while the app is closed)`, 'Exports: stored at the destination you choose, retained until you delete that file.', "Persisted: user/assistant text, model context, tool interactions, usage and bounded redacted attachments (16 × 2 MiB/session).", "Context can contain source code, paths, customer data and unrecognized secrets.", "Default export: diagnostic summary; no conversation, source, tool bodies, paths or reasoning.", "Cleanup excludes active, unknown and retained-team sessions. Failures can be retried with a new preview.", "Memory, keyring credentials, input history and exported files have separate storage and are not removed by Session cleanup.", "Deletion removes application files; it does not erase backups, disk remnants or external copies."].join("\n");
  }
}
