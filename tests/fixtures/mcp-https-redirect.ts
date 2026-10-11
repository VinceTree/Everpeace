import assert from "node:assert/strict";
import { createMcpHttp } from "../../src/mcp/http.js";

const endpoint = process.argv[2];
if (!endpoint) throw new Error("Missing HTTPS fixture endpoint");
let failures = 0;
const client = createMcpHttp(endpoint, () => { failures++; });
try {
  for (const method of ["POST", "GET", "DELETE"]) {
    await assert.rejects(client.fetch(endpoint, { method, headers: { "X-Secret": "fixture-secret" } }), /redirects are blocked/u);
  }
  assert.equal(failures, 3);
} finally { await client.close(); }
