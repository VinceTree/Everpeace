import { createHash } from "node:crypto";
import { stableJson } from "../../src/mcp/launch.js";
import type { McpTrustIdentity, McpTrustKind, McpTrustStoreLike } from "../../src/mcp/trust.js";
import type { AuthStorage } from "../../src/storage/auth-storage.js";

export class MemoryAuthStorage implements AuthStorage {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
}

/** Explicit fixture authorization only; never reads user grants or keyring. */
export function approvedMcpFixture(): McpTrustStoreLike {
  return {
    async evaluate(workspace: string, name: string, kind: McpTrustKind, material: unknown) {
      return { workspace, name, kind, fingerprint: createHash("sha256").update(stableJson(material)).digest("hex"), revision: 0, approved: true };
    },
    async grant(_identity: McpTrustIdentity) {},
    async revoke() {},
  };
}
