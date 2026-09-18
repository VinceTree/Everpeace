import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bashPermission,
  defaultPermissions,
  webPermission,
} from "../../src/permissions/policy.js";

test("workspace-write is the friction-free current-workspace default", () => {
  const policy = defaultPermissions();
  assert.deepEqual(policy, { mode: "workspace-write", web: true });
  assert.equal(bashPermission(policy), "allow");
  assert.equal(webPermission(policy), "ask");
});

test("read-only and ask profiles gate Bash and web requests", () => {
  for (const mode of ["read-only", "ask"] as const) {
    const policy = { mode, web: true } as const;
    assert.equal(bashPermission(policy), "ask");
    assert.equal(webPermission(policy), "ask");
  }
});

test("disabling web always wins over the selected profile", () => {
  assert.equal(webPermission({ mode: "workspace-write", web: false }), "deny");
  assert.equal(webPermission({ mode: "full-access", web: false }), "deny");
});
