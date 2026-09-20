import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bashPermission,
  codexSandboxProfile,
  defaultPermissions,
  mcpPermission,
  webPermission,
} from "../../src/permissions/policy.js";

test("workspace-write is the friction-free current-workspace default", () => {
  const policy = defaultPermissions();
  assert.deepEqual(policy, { mode: "workspace-write", web: true });
  assert.equal(bashPermission(policy), "allow");
  assert.equal(webPermission(policy), "allow");
  assert.equal(mcpPermission(policy), "ask");
  assert.equal(codexSandboxProfile(policy), ":workspace");
});

test("permission modes map to Codex native sandbox profiles", () => {
  assert.equal(codexSandboxProfile({ mode: "read-only", web: true }), ":read-only");
  assert.equal(codexSandboxProfile({ mode: "ask", web: true }), ":workspace");
  assert.equal(codexSandboxProfile({ mode: "full-access", web: true }), ":danger-full-access");
  assert.equal(mcpPermission({ mode: "full-access", web: false }), "allow");
});

test("read-only and ask profiles gate Bash and web requests", () => {
  for (const mode of ["read-only", "ask"] as const) {
    const policy = { mode, web: true } as const;
    assert.equal(bashPermission(policy), "ask");
    assert.equal(webPermission(policy), "ask");
  }
});

test("workspace-write allows enabled public web tools without per-request approval", () => {
  assert.equal(webPermission({ mode: "workspace-write", web: true }), "allow");
});

test("disabling web always wins over the selected profile", () => {
  assert.equal(webPermission({ mode: "workspace-write", web: false }), "deny");
  assert.equal(webPermission({ mode: "full-access", web: false }), "deny");
});
