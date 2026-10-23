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

test("lint accepts tracked deletions and checks untracked rename destinations", async () => {
  const fixture = await fs.mkdtemp(join(tmpdir(), "everpeace-lint-changes-"));
  try {
    execFileSync("git", ["init", "--quiet", fixture], { windowsHide: true });
    await fs.mkdir(join(fixture, "src"));
    await fs.copyFile(new URL("../../../.oxlintrc.json", import.meta.url), join(fixture, ".oxlintrc.json"));
    await fs.writeFile(join(fixture, "src", "deleted.ts"), "export const deleted = true;\n");
    await fs.writeFile(join(fixture, "src", "old name.ts"), "export const renamed = true;\n");
    execFileSync("git", ["-C", fixture, "add", "src"], { windowsHide: true });
    await fs.unlink(join(fixture, "src", "deleted.ts"));
    await fs.rename(join(fixture, "src", "old name.ts"), join(fixture, "src", "新 name.ts"));
    await fs.writeFile(join(fixture, ".gitignore"), "src/ignored.ts\n");
    await fs.writeFile(join(fixture, "src", "ignored.ts"), "const unused = 1;\n");
    const run = () => spawnSync(process.execPath, [fileURLToPath(new URL("../../../scripts/lint.mjs", import.meta.url))], { cwd: fixture, encoding: "utf8", windowsHide: true });
    const deleted = run();
    assert.equal(deleted.status, 0, deleted.stdout + deleted.stderr);
    execFileSync("git", ["-C", fixture, "add", "-u"], { windowsHide: true });
    assert.equal(run().status, 0);
    await fs.writeFile(join(fixture, "src", "新 name.ts"), "const unused = 1;\n");
    const invalid = run();
    assert.equal(invalid.status, 1);
    assert.match(invalid.stdout + invalid.stderr, /no-unused-vars/u);
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
});

test("lint refuses an empty source set and a tracked file replaced by a directory", async () => {
  const fixture = await fs.mkdtemp(join(tmpdir(), "everpeace-lint-inputs-"));
  try {
    execFileSync("git", ["init", "--quiet", fixture], { windowsHide: true });
    await fs.mkdir(join(fixture, "src"));
    await fs.copyFile(new URL("../../../.oxlintrc.json", import.meta.url), join(fixture, ".oxlintrc.json"));
    const file = join(fixture, "src", "tracked.ts");
    await fs.writeFile(file, "export const tracked = true;\n");
    execFileSync("git", ["-C", fixture, "add", "src"], { windowsHide: true });
    await fs.unlink(file);
    const run = () => spawnSync(process.execPath, [fileURLToPath(new URL("../../../scripts/lint.mjs", import.meta.url))], { cwd: fixture, encoding: "utf8", windowsHide: true });
    const empty = run();
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /no maintained source files/u);
    await fs.mkdir(file);
    const directory = run();
    assert.notEqual(directory.status, 0);
    assert.match(directory.stderr, /regular file/u);
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
});
