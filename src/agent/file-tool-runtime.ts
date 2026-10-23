import path from "node:path";
import { FileSearchSession, runFileTool } from "../tools/files.js";
import { WorkspaceReviewSession } from "../tools/workspace.js";
import type { ApplyPatchPreview, ApplyPatchResult } from "../tools/apply-patch.js";

/** Current-process observations are never reconstructed from Session text. */
export class FileToolRuntime {
  readonly observations = new Map<string, string | null>();
  readonly identities = new Map<string, string>();
  readonly activeFiles = new Set<string>();
  readonly searches = new FileSearchSession();
  readonly reviews: WorkspaceReviewSession;
  constructor(readonly workspace: string) { this.reviews = new WorkspaceReviewSession(workspace); }
  key(value: string): string { const normalized = path.normalize(value); return process.platform === "win32" ? normalized.toLowerCase() : normalized; }
  observed(value: string): string | null | undefined { return this.observations.get(this.key(value)); }
  async run(name: string, args: string, signal?: AbortSignal): Promise<unknown> {
    const result = await runFileTool(name, args, this.workspace, signal, this.searches);
    if (name === "read_file" && result && typeof result === "object") {
      const record = result as { path?: unknown; exists?: unknown; sha256?: unknown; file_identity?: unknown };
      if (typeof record.path === "string" && typeof record.exists === "boolean" && (typeof record.sha256 === "string" || record.sha256 === null)) this.observations.set(this.key(record.path), record.sha256);
      if (typeof record.path === 'string' && typeof record.file_identity === 'string') this.identities.set(this.key(record.path), record.file_identity);
    }
    return result;
  }
  applied(preview: ApplyPatchPreview, result: ApplyPatchResult): void {
    if (preview.status !== 'ready') return;
    for (const file of preview.files) {
      const key = this.key(file.path); const identity = result.files.find(value => this.key(value.path) === key)?.afterFileIdentity;
      if (identity) { this.observations.set(key, file.afterSha256); this.identities.set(key, identity); }
      else { this.observations.delete(key); this.identities.delete(key); }
    }
  }
  dispose(): void { this.searches.clear(); this.reviews.clear(); this.observations.clear(); this.identities.clear(); this.activeFiles.clear(); }
}
