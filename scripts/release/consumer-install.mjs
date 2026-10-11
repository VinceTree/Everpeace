import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPackage } from "./policy.mjs";
import { packageManager, runCommand } from "./commands.mjs";

const directory = path.resolve(process.argv[2] ?? "candidate-package");
const local = process.argv[3] === "--local";
if (local) assert.notEqual(process.env.GITHUB_ACTIONS, "true", "Local mode is not a release check");
const receipt = JSON.parse(await fs.readFile(path.join(directory, "receipt.json"), "utf8"));
assert.match(receipt.filename, /^everpeace-[0-9A-Za-z.+-]+\.tgz$/u);
const tarball = path.join(directory, receipt.filename);
verifyPackage(receipt, tarball, process.env.CANDIDATE_SHA ?? receipt.commit, process.env.PACKAGE_SHA256 ?? receipt.sha256, !local);
if (!local) { assert.ok(process.env.CANDIDATE_SHA); assert.ok(process.env.PACKAGE_SHA256); }
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-consumer-"));
const checks = [];
let cleanupFailed = false;
try {
  for (const mode of ["npm", "pnpm", "global"]) {
    const consumer = path.join(temporary, mode);
    const home = path.join(consumer, "home");
    const prefix = path.join(consumer, "prefix");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
    await fs.writeFile(path.join(consumer, "empty.npmrc"), "");
    await fs.writeFile(path.join(consumer, "global.npmrc"), "");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:npm_config_|npm_|pnpm_|NODE_OPTIONS$|NODE_PATH$)/iu.test(key)));
    Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"), XDG_CONFIG_HOME: path.join(home, ".config"), NPM_CONFIG_USERCONFIG: path.join(consumer, "empty.npmrc"), NPM_CONFIG_GLOBALCONFIG: path.join(consumer, "global.npmrc"), NPM_CONFIG_CACHE: path.join(consumer, "cache"), NPM_CONFIG_REGISTRY: "https://registry.npmjs.org" });
    if (mode === "pnpm") {
      await fs.writeFile(path.join(consumer, "pnpm-workspace.yaml"), "onlyBuiltDependencies:\n  - node-pty\n");
      await packageManager("pnpm", ["add", tarball, "--store-dir", path.join(consumer, "store"), "--reporter=append-only"], { cwd: consumer, env, stdio: "inherit" });
    } else await packageManager("npm", ["install", ...(mode === "global" ? ["--global", "--prefix", prefix] : []), tarball, "--no-audit", "--no-fund"], { cwd: consumer, env, stdio: "inherit" });
    const installed = mode === "global" ? path.join(prefix, process.platform === "win32" ? "node_modules" : "lib/node_modules", "everpeace") : path.join(consumer, "node_modules/everpeace");
    await fs.copyFile(fileURLToPath(new URL("./consumer-fixture.mjs", import.meta.url)), path.join(installed, "consumer-fixture.mjs"));
    await runCommand(process.execPath, ["--test", "consumer-fixture.mjs"], { cwd: installed, env, stdio: "inherit", timeout: 90_000 });
    if (mode === "global") {
      const bin = path.join(prefix, process.platform === "win32" ? "everpeace.cmd" : "bin/everpeace");
      // Use a fixed command in the owned prefix; Node's normal Windows argument quoting escapes cmd quotes.
      const help = process.platform === "win32" ? await runCommand("cmd.exe", ["/d", "/s", "/c", "everpeace.cmd --help"], { cwd: prefix, env, windowsVerbatimArguments: true, timeout: 20_000 }) : await runCommand(bin, ["--help"], { env, timeout: 20_000 });
      assert.match(help, /--team/u);
    }
    checks.push({ mode, success: true });
  }
} catch (error) { cleanupFailed = error.cleanupFailed === true; throw error; }
finally {
  await fs.writeFile(path.join(directory, `consumer-${process.platform}-${process.arch}.json`), JSON.stringify({ schema: 1, commit: receipt.commit, packageSha256: receipt.sha256, node: process.version, platform: process.platform, arch: process.arch, success: checks.length === 3, local, checks }, null, 2) + "\n");
  assert.equal(path.dirname(temporary), os.tmpdir());
  assert.ok(path.basename(temporary).startsWith("everpeace-consumer-"));
  if (!cleanupFailed) await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log("Clean npm, pnpm and global consumer installation verified.");
