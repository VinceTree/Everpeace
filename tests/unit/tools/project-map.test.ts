import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runFileTool } from "../../../src/tools/files.js";
import { projectMapLimits, runProjectMap } from "../../../src/tools/project-map.js";
import { resolveBundledRipgrep } from "../../../src/tools/ripgrep.js";

async function workspace(run: (root: string, write: (file: string, text?: string) => Promise<void>) => Promise<void>) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-map-"));
  const root = path.join(parent, "中文 空格");
  await fs.mkdir(root);
  const write = async (file: string, text = "source body should never appear") => { const target = path.join(root, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text); };
  try { await run(root, write); } finally { await fs.rm(parent, { recursive: true, force: true }); }
}

test("project map reports Node declarations separately from candidates and refreshes without source bodies", async () => {
  await workspace(async (root, write) => {
    await write("package.json", JSON.stringify({ name: "personal", main: "dist/index.js", bin: { personal: "dist/cli.js" }, exports: { ".": { import: "./dist/main.js" } }, scripts: { test: "node --test" }, credentials: "DO_NOT_PROJECT" }));
    for (const file of ["README.md", "AGENTS.md", "src/index.ts", "src/nested/deeper/main.ts", "tests/a.test.ts", "tsconfig.json"]) await write(file);
    const first = await runProjectMap({}, root);
    assert.equal(first.incomplete, false);
    assert.equal(first.depth, 2);
    assert.equal(first.fileTypes[".ts"], 3);
    assert.equal(first.packages[0]?.name, "personal");
    assert.deepEqual({ ...first.packages[0]?.scripts }, { test: "node --test" });
    assert.ok(first.packages[0]?.declaredEntries.some((entry) => entry.field === "exports...import" && entry.value === "./dist/main.js"));
    assert.ok(first.locations.entryCandidates.includes("src/index.ts"));
    assert.ok(first.locations.agents.includes("AGENTS.md"));
    assert.ok(first.locations.tests.includes("tests/a.test.ts"));
    assert.ok(first.locations.config.includes("tsconfig.json"));
    assert.equal(JSON.stringify(first).includes("source body should never appear"), false);
    assert.equal(JSON.stringify(first).includes("DO_NOT_PROJECT"), false);
    assert.equal(first.structure.some((entry) => entry.path === "src/nested/deeper/main.ts"), false);
    const deep = await runProjectMap({ depth: 4 }, root);
    assert.equal(deep.observedFiles, first.observedFiles);
    assert.ok(deep.structure.some((entry) => entry.path === "src/nested/deeper/main.ts"));
    await fs.unlink(path.join(root, "src/index.ts"));
    await write("src/app.ts");
    const fresh = await runProjectMap({ path: "src" }, root);
    assert.ok(fresh.locations.entryCandidates.includes("src/app.ts"));
    assert.equal(fresh.locations.entryCandidates.includes("src/index.ts"), false);
  });
});

test("project map handles monorepos, non-Node manifests, ignore rules, and control directories", async () => {
  await workspace(async (root, write) => {
    await promisify(execFile)("git", ["init", "--quiet"], { cwd: root });
    await write(".gitignore", "ignored/\n");
    for (const file of ["ignored/file.ts", "node_modules/p/package.json", ".codex/secret", ".agents/secret", ".everpeace/secret", "vendor/pkg/source.go", ".venv/bin/python"]) await write(file);
    for (const file of ["package.json", "packages/a/package.json", "packages/b/package.json"]) await write(file, JSON.stringify({ name: file, scripts: { build: "tsc" } }));
    await write("python/pyproject.toml", "[project]\nname='not parsed'");
    await write("rust/Cargo.toml", "[package]");
    await write("go/go.mod", "module example");
    const map = await runFileTool("project_map", "{}", root) as Awaited<ReturnType<typeof runProjectMap>>;
    assert.equal(map.packages.length, 3);
    assert.ok(map.locations.manifests.includes("python/pyproject.toml"));
    assert.ok(map.locations.manifests.includes("rust/Cargo.toml"));
    assert.equal(JSON.stringify(map).includes("secret"), false);
    assert.equal(JSON.stringify(map).includes("ignored/file.ts"), false);
    const python = await runProjectMap({ path: "python" }, root);
    assert.equal(python.packages.length, 0);
    assert.deepEqual(python.locations.manifests, ["python/pyproject.toml"]);
    assert.equal(python.incomplete, false);
  });
});

test("project map validates arguments before scanning and rejects escape, protected scopes and directory symlinks", async () => {
  await workspace(async (root, write) => {
    let launches = 0;
    const resolver = async () => { launches++; return resolveBundledRipgrep(); };
    for (const args of [{ depth: 0 }, { depth: 5 }, { depth: 1.5 }, { depth: "2" }, { path: "" }, { surprise: true }]) await assert.rejects(runProjectMap(args, root, undefined, resolver), /Invalid tool argument/u);
    assert.equal(launches, 0);
    await assert.rejects(runProjectMap({ path: ".." }, root), /limited to workspace/u);
    await write(".codex/secret");
    await assert.rejects(runProjectMap({ path: ".codex" }, root), /excludes/u);
    await write("source/index.ts");
    await fs.symlink(path.join(root, "source"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    await fs.symlink(path.dirname(root), path.join(root, "outside"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(runProjectMap({ path: "alias" }, root), /symbolic links/u);
    await assert.rejects(runProjectMap({ path: "outside" }, root), /symbolic links/u);
    const map = await runProjectMap({}, root);
    assert.equal(map.structure.some((entry) => entry.path.startsWith("alias") || entry.path.startsWith("outside")), false);
    await assert.rejects(runProjectMap({ path: "source/index.ts" }, root), /directory/u);
    const controller = new AbortController(); controller.abort(new Error("fixture cancel"));
    await assert.rejects(runProjectMap({}, root, controller.signal, resolver), /fixture cancel/u);
    assert.equal(launches, 0);
  });
});

test("project map reports malformed manifests and all bounded scan/metadata/output limits", async () => {
  await workspace(async (root, write) => {
    await write("broken/package.json", "{");
    await write("large/package.json", " ".repeat(projectMapLimits.manifestBytes + 1));
    const map = await runProjectMap({}, root);
    assert.equal(map.incomplete, true);
    assert.ok(map.reasons.includes("manifest_invalid_or_unreadable"));
    assert.ok(map.reasons.includes("manifest_byte_limit"));
    await write("nested/package.json", JSON.stringify({ exports: { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: "./index.js" } } } } } } } } } } }));
    assert.ok((await runProjectMap({}, root)).reasons.includes("manifest_metadata_limit"));
    await fs.rm(path.join(root, "nested"), { recursive: true });
    await fs.rm(path.join(root, "broken"), { recursive: true });
    await fs.rm(path.join(root, "large"), { recursive: true });
    for (let index = 0; index < 33; index++) await write(`pkg${index}/package.json`, JSON.stringify({ name: `pkg${index}` }));
    const count = await runProjectMap({}, root);
    assert.equal(count.packages.length, 32);
    assert.ok(count.reasons.includes("manifest_count_limit"));
    for (const [limits, expected] of [
      [{ paths: 2 }, "path_limit"], [{ scanBytes: 32 }, "enumeration_byte_limit"],
      [{ totalManifestBytes: 30 }, "manifest_total_byte_limit"], [{ outputBytes: 1800 }, "output_limit"], [{ timeoutMs: 0 }, "enumeration_timeout"],
    ] as const) {
      const bounded = await runProjectMap({}, root, undefined, resolveBundledRipgrep, { ...projectMapLimits, ...limits });
      assert.equal(bounded.incomplete, true);
      assert.ok(bounded.reasons.includes(expected), JSON.stringify(bounded.reasons));
      assert.match(bounded.guidance, /narrower/u);
      if ("outputBytes" in limits) assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= limits.outputBytes);
    }
  });
});
