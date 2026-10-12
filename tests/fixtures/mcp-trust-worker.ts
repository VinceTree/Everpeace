import { McpTrustStore } from "../../src/mcp/trust.js";
const [path, workspace, name, action] = process.argv.slice(2);
if (!path || !workspace || !name) throw new Error("Missing fixture arguments");
const store = new McpTrustStore({ path, authStorage: { async get() { return "cross-process-fixture-key"; }, async set() {}, async delete() { return true; } } });
if (action === "revoke") await store.revoke(workspace, name);
else {
  for (let attempt = 0; ; attempt++) {
    const preview = await store.evaluate(workspace, name, "mcp_start", { fixture: name });
    try { await store.grant(preview); break; } catch (error) { if (attempt >= 10) throw error; }
  }
}
