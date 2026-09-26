import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  bashPermission,
  codexSandboxProfile,
  commandPermission,
  defaultPermissions,
  defaultPermissionPath,
  loadPermissionPolicy,
  mcpPermission,
  projectPermissionPath,
  savePermissionPolicy,
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

test("command prefix rules use boundaries, longest match, and deny precedence", () => {
  const policy = {
    mode: "workspace-write" as const,
    web: true,
    commandRules: [
      { prefix: "git", action: "deny" as const },
      { prefix: "git status", action: "allow" as const },
      { prefix: "git status --short", action: "ask" as const },
    ],
  };
  assert.equal(commandPermission("git status --short", policy), "ask");
  assert.equal(commandPermission("git status --short --branch", policy), "ask");
  assert.equal(commandPermission("git status-all", policy), "deny");
  assert.equal(commandPermission("git commit -am fix", policy), "deny");
});

test("ask profile cannot be relaxed by an allow prefix rule", () => {
  assert.equal(commandPermission("npm test", {
    mode: "ask",
    web: true,
    commandRules: [{ prefix: "npm test", action: "allow" }],
  }), "ask");
});

test("permission policy paths are stable and persist without credentials", async () => {
  assert.equal(defaultPermissionPath("win32", { APPDATA: "C:\\AppData" }, "C:\\Users\\test"), "C:\\AppData\\Everpeace\\permissions.json");
  assert.equal(projectPermissionPath("C:\\repo"), "C:\\repo\\.everpeace\\permissions.json");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-policy-"));
  try {
    const userPath = path.join(root, "user.json");
    const projectPath = path.join(root, "project.json");
    await savePermissionPolicy({ mode: "ask", web: false, commandRules: [{ prefix: "pnpm test", action: "allow" }] }, root, { userPath, scope: "user" });
    await savePermissionPolicy({ mode: "workspace-write", web: true }, root, { projectPath, scope: "project" });
    const loaded = await loadPermissionPolicy(root, { userPath, projectPath });
    assert.deepEqual(loaded, { mode: "ask", web: false, commandRules: [{ prefix: "pnpm test", action: "allow" }] });
    assert.doesNotMatch(await fs.readFile(userPath, "utf8"), /api[_-]?key|token|secret/iu);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("permission policy writes serialize and leave no temporary files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-policy-queue-"));
  try {
    const userPath = path.join(root, "user.json");
    await Promise.all([
      savePermissionPolicy({ mode: "ask", web: true }, root, { userPath, scope: "user" }),
      savePermissionPolicy({ mode: "read-only", web: false }, root, { userPath, scope: "user" }),
    ]);
    const loaded = await loadPermissionPolicy(root, { userPath, projectPath: path.join(root, "missing-project.json") });
    assert.deepEqual(loaded, { mode: "read-only", web: false });
    assert.deepEqual(await fs.readdir(root), ["user.json"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
