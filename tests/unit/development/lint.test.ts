import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("lint rejects maintained source errors while excluding unrelated untracked directories", async () => {
  const fixture = await fs.mkdtemp(join(tmpdir(), "everpeace-lint-"));
  try {
    execFileSync("git", ["init", "--quiet", fixture], { windowsHide: true });
    await fs.mkdir(join(fixture, "src")); await fs.mkdir(join(fixture, "user-files"));
    await fs.copyFile(new URL("../../../.oxlintrc.json", import.meta.url), join(fixture, ".oxlintrc.json"));
    await fs.writeFile(join(fixture, "src", "good.ts"), "export const good = true;\n");
    await fs.writeFile(join(fixture, "user-files", "unrelated.ts"), "const unused = 1;\n");
    const run = () => spawnSync(process.execPath, [fileURLToPath(new URL("../../../scripts/lint.mjs", import.meta.url))], { cwd: fixture, encoding: "utf8", windowsHide: true });
    assert.equal(run().status, 0);
    await fs.writeFile(join(fixture, "src", "bad.ts"), "const unused = 1;\n");
    const result = run(); assert.equal(result.status, 1); assert.match(result.stdout + result.stderr, /no-unused-vars/u);
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
});
