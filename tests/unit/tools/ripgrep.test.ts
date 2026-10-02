import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBundledRipgrepResolver } from "../../../src/tools/ripgrep.js";

test("bundled ripgrep resolver is lazy, absolute, and cached", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-rg-中文 空格-"));
  const executable = path.join(root, process.platform === "win32" ? "rg.exe" : "rg");
  let loads = 0;
  try {
    await fs.writeFile(executable, "fixture", "utf8");
    const resolve = createBundledRipgrepResolver(async () => {
      loads += 1;
      return { rgPath: executable };
    });
    assert.equal(loads, 0);
    assert.equal(await resolve(), executable);
    assert.equal(await resolve(), executable);
    assert.equal(loads, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bundled ripgrep resolver explains a missing platform package", async () => {
  const resolve = createBundledRipgrepResolver(async () => {
    throw new Error("Could not find @vscode/ripgrep-example-platform");
  });
  await assert.rejects(
    resolve(),
    /Bundled ripgrep is unavailable.*Reinstall Everpeace with optional dependencies enabled.*ripgrep-example-platform/iu,
  );
});

test("bundled ripgrep resolver rejects non-absolute module paths", async () => {
  const resolve = createBundledRipgrepResolver(async () => ({ rgPath: "rg" }));
  await assert.rejects(resolve(), /absolute executable path/iu);
});
