import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../../../scripts/build.mjs", import.meta.url));
const buildConfig = JSON.parse(await fs.readFile(new URL("../../../tsconfig.build.json", import.meta.url), "utf8"));
const run = (cwd: string) => spawnSync(process.execPath, [script], { cwd, encoding: "utf8", windowsHide: true });

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "everpeace-build-"));
  await fs.mkdir(join(root, "src"));
  await fs.writeFile(join(root, "package.json"), '{"type":"module"}');
  await fs.writeFile(join(root, "tsconfig.build.json"), JSON.stringify({
    compilerOptions: { ...buildConfig.compilerOptions, types: [], strict: true, target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext" },
    include: ["src/*.ts"],
  }));
  return root;
}

async function cleanup(root: string) {
  assert.equal(dirname(root), tmpdir());
  assert.ok(root.startsWith(join(tmpdir(), "everpeace-build-")));
  await fs.rm(root, { recursive: true, force: true });
}

test("build removes deleted and renamed modules and remains repeatable", async () => {
  const root = await fixture();
  try {
    await fs.writeFile(join(root, "src", "old.ts"), "export const renamed = 1;\n");
    await fs.writeFile(join(root, "src", "deleted.ts"), "export const deleted = 2;\n");
    const initial = run(root);
    assert.equal(initial.status, 0, initial.stdout + initial.stderr);
    assert.ok((await fs.readdir(join(root, "dist"))).includes("deleted.js"));
    await fs.rename(join(root, "src", "old.ts"), join(root, "src", "new.ts"));
    await fs.unlink(join(root, "src", "deleted.ts"));
    for (let attempt = 0; attempt < 2; attempt++) {
      const rebuilt = run(root);
      assert.equal(rebuilt.status, 0, rebuilt.stdout + rebuilt.stderr);
      assert.deepEqual((await fs.readdir(join(root, "dist"))).sort(), ["new.d.ts", "new.js", "new.js.map"]);
    }
  } finally { await cleanup(root); }
});

test("failed compilation leaves neither stale nor newly emitted runnable modules", async () => {
  const root = await fixture();
  try {
    await fs.writeFile(join(root, "src", "value.ts"), "export const value = 1;\n");
    const initial = run(root);
    assert.equal(initial.status, 0, initial.stdout + initial.stderr);
    await fs.writeFile(join(root, "src", "value.ts"), "export const value: string = 1;\n");
    const failed = run(root);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stdout + failed.stderr, /TS2322/u);
    await assert.rejects(fs.stat(join(root, "dist")), { code: "ENOENT" });
  } finally { await cleanup(root); }
});

test("build refuses redirected output and preserves the destination", async () => {
  const root = await fixture();
  try {
    const target = join(root, "unrelated");
    await fs.mkdir(target);
    await fs.writeFile(join(target, "keep.txt"), "preserve this directory");
    await fs.symlink(target, join(root, "dist"), process.platform === "win32" ? "junction" : "dir");
    const refused = run(root);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /ordinary dist directory/u);
    assert.equal(await fs.readFile(join(target, "keep.txt"), "utf8"), "preserve this directory");
    assert.equal((await fs.lstat(join(root, "dist"))).isSymbolicLink(), true);
  } finally { await cleanup(root); }
});
