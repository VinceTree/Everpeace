import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("document checks accept tracked deletions while checking new files and remaining links", async () => {
  const fixture = await fs.mkdtemp(join(tmpdir(), "everpeace-docs-changes-"));
  try {
    execFileSync("git", ["init", "--quiet", fixture], { windowsHide: true });
    await fs.mkdir(join(fixture, "docs"));
    await fs.writeFile(join(fixture, "docs", "deleted.md"), "Removed document.\n");
    await fs.writeFile(join(fixture, "docs", "old name.md"), "Renamed document.\n");
    execFileSync("git", ["-C", fixture, "add", "docs"], { windowsHide: true });
    await fs.unlink(join(fixture, "docs", "deleted.md"));
    await fs.rename(join(fixture, "docs", "old name.md"), join(fixture, "docs", "新 name.md"));
    await fs.writeFile(join(fixture, ".gitignore"), "docs/ignored.md\n");
    await fs.writeFile(join(fixture, "docs", "ignored.md"), "[ignored](missing.md)\n");
    const run = () => spawnSync(process.execPath, [fileURLToPath(new URL("../../../scripts/check-public-docs.mjs", import.meta.url))], { cwd: fixture, encoding: "utf8", windowsHide: true });
    const deleted = run();
    assert.equal(deleted.status, 0, deleted.stdout + deleted.stderr);
    await fs.writeFile(join(fixture, "README.md"), "[stale link](docs/deleted.md)\n");
    const broken = run();
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /broken local link docs\/deleted\.md/u);
    await fs.writeFile(join(fixture, "README.md"), "[renamed](docs/新 name.md)\n");
    execFileSync("git", ["-C", fixture, "add", "-u"], { windowsHide: true });
    assert.equal(run().status, 0);
    await fs.writeFile(join(fixture, "docs", "新 name.md"), ["/home", "fixture-user", "private.log"].join("/") + "\n");
    const privatePath = run();
    assert.equal(privatePath.status, 1);
    assert.match(privatePath.stderr, /machine-specific path/u);
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
});
