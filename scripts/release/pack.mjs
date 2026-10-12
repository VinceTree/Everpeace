import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { candidateSha, digest, requirePortableBuild } from "./policy.mjs";
import { packageManager } from "./commands.mjs";
import { sourceIdentity } from "./source-identity.mjs";
import { sbom } from "../security/tools.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
assert.equal(args[0], "--output", "Specify --output <empty directory>");
assert.equal(args.length, 2);
const output = path.resolve(args[1]);
await fs.mkdir(output, { recursive: true });
assert.equal((await fs.readdir(output)).length, 0, "Output directory must be empty");
const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const pins = JSON.parse(await fs.readFile(new URL("./native-packages.json", import.meta.url), "utf8"));
const commit = candidateSha(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
const identity = sourceIdentity(root);
const { dirty } = identity;
let cleanupFailed = false;
if (process.env.CANDIDATE_SHA) { assert.equal(commit, candidateSha(process.env.CANDIDATE_SHA)); assert.equal(dirty, false, "Release requires a clean candidate"); requirePortableBuild(process.platform, process.arch); }
const staging = await fs.mkdtemp(path.join(tmpdir(), "everpeace-pack-"));
try {
  for (const entry of manifest.files) {
    assert.ok(!path.isAbsolute(entry) && !entry.split(/[\\/]/u).includes(".."));
    await fs.cp(path.join(root, entry), path.join(staging, entry), { recursive: true });
  }
  assert.ok((await fs.stat(path.join(staging, "dist/cli/index.js"))).isFile(), "Build before packing");
  const fileWorker = 'native/files/bin/win32-x64/everpeace-files.exe';
  const fileWorkerDigest = digest(path.join(staging, fileWorker));
  assert.equal((await fs.readFile(path.join(staging, `${fileWorker}.sha256`), 'utf8')).trim(), fileWorkerDigest, 'Build and verify the Windows file helper before packing');
  for (const [name, pin] of Object.entries(pins)) {
    if (name === "node-pty") assert.equal(manifest.dependencies[name], pin.version);
    const download = path.join(staging, `download-${name}`);
    await fs.mkdir(download);
    const result = JSON.parse(await packageManager("npm", ["pack", `${name}@${pin.version}`, "--ignore-scripts", "--json", "--registry=https://registry.npmjs.org", "--pack-destination", download], { cwd: download }));
    const archive = path.join(download, result[0].filename);
    const bytes = await fs.readFile(archive);
    assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, pin.integrity, `Upstream integrity mismatch for ${name}`);
    const lock = await fs.readFile(path.join(root, "pnpm-lock.yaml"), "utf8");
    assert.ok(lock.includes(`  ${name}@${pin.version}:\n    resolution: {integrity: ${pin.integrity}}`) || lock.replaceAll("\r\n", "\n").includes(`  ${name}@${pin.version}:\n    resolution: {integrity: ${pin.integrity}}`), "Native pins must match the lockfile");
    // Extraction only follows verification of the exact audited upstream bytes.
    execFileSync("tar", ["-xzf", archive, "-C", download], { windowsHide: true });
    const target = name === "node-pty" ? path.join(staging, "node_modules/node-pty") : path.join(staging, "node_modules/node-pty/node_modules/node-addon-api");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(path.join(download, "package"), target);
    if (name === "node-pty") {
      // Match pnpm patch context, including npm's missing compiled-JS EOF newline.
      for (const file of ["lib/conpty_console_list_agent.js", "lib/windowsPtyAgent.js", "src/conpty_console_list_agent.ts", "src/windowsPtyAgent.ts", "lib/worker/conoutSocketWorker.js", "src/worker/conoutSocketWorker.ts"]) {
        const location = path.join(target, file);
        await fs.writeFile(location, (await fs.readFile(location, "utf8")).replaceAll("\r\n", "\n").replace(/\n?$/u, "\n"));
      }
      const patchFile = path.join(staging, "native-dependency.patch");
      await fs.writeFile(patchFile, (await fs.readFile(path.join(root, "patches/node-pty@1.1.0.patch"), "utf8")).replaceAll("\r\n", "\n"));
      execFileSync("git", ["apply", "--", patchFile], { cwd: target, windowsHide: true });
      await fs.rm(patchFile);
    }
  }
  const bundled = JSON.parse(await fs.readFile(path.join(staging, "node_modules/node-pty/package.json"), "utf8"));
  bundled.dependencies["node-addon-api"] = pins["node-addon-api"].version;
  await fs.writeFile(path.join(staging, "node_modules/node-pty/package.json"), JSON.stringify(bundled, null, 2) + "\n");
  manifest.scripts = {}; // Installation uses dependency-native scripts, never repository build/patch hooks.
  delete manifest.devDependencies;
  await fs.writeFile(path.join(staging, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  const native = { packages: pins, patchSha256: digest(path.join(root, "patches/node-pty@1.1.0.patch")) };
  if (process.platform === "linux") {
    // pnpm does not run bundled child install scripts. Build from the audited staging source,
    // retaining upstream Windows/macOS prebuilds rather than copying this checkout's build output.
    requirePortableBuild(process.platform, process.arch);
    await packageManager("npm", ["rebuild", "node-pty", "--ignore-scripts=false", "--build-from-source=false", "--no-audit", "--no-fund"], { cwd: staging });
    const nativeRoot = path.join(staging, "node_modules/node-pty");
    const prebuild = path.join(nativeRoot, "prebuilds/linux-x64");
    await fs.mkdir(prebuild);
    const files = {};
    // The pinned gyp definition builds spawn-helper only on macOS; Linux forks directly.
    for (const file of ["pty.node"]) {
      await fs.copyFile(path.join(nativeRoot, "build/Release", file), path.join(prebuild, file));
      await fs.chmod(path.join(prebuild, file), file === "spawn-helper" ? 0o755 : 0o644);
      files[file] = digest(path.join(prebuild, file));
    }
    native.build = { platform: process.platform, arch: process.arch, node: process.version, files };
    assert.ok(nativeRoot.startsWith(staging + path.sep));
    await fs.rm(path.join(nativeRoot, "build"), { recursive: true, force: true });
  }
  const binaryFiles = {};
  const visitNative = async (directory) => {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const location = path.join(directory, item.name);
      if (item.isDirectory()) await visitNative(location);
      else if (item.isFile() && /\.(?:node|dll|exe|so|dylib)$/iu.test(item.name)) binaryFiles[path.relative(staging, location).replaceAll("\\", "/")] = digest(location);
    }
  };
  await visitNative(path.join(staging, "node_modules/node-pty"));
  binaryFiles[fileWorker] = fileWorkerDigest;
  assert.ok(Object.keys(binaryFiles).length, "Native binary inventory missing");
  native.binaryFiles = binaryFiles;
  native.coverageLimit = "Binary digests identify delivered native components; statically linked internal dependency versions may not be identifiable.";
  await fs.writeFile(path.join(staging, "native-provenance.json"), JSON.stringify(native, null, 2) + "\n");
  manifest.files.push("native-provenance.json");
  await fs.writeFile(path.join(staging, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  const packed = JSON.parse(await packageManager("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output], { cwd: staging }))[0];
  for (const required of [fileWorker, `${fileWorker}.sha256`]) assert.ok(packed.files.some(file => file.path === required), `Missing native file worker: ${required}`);
  assert.ok(!packed.files.some(file => /everpeace-files-test\.exe(?:\.sha256)?$/u.test(file.path)), 'Fault-injection workers must not be distributed');
  for (const required of ["node_modules/node-pty/lib/windowsPtyAgent.js", "node_modules/node-pty/lib/conpty_console_list_agent.js", "node_modules/node-pty/node_modules/node-addon-api/package.json", "node_modules/node-pty/LICENSE", "node_modules/node-pty/prebuilds/win32-x64/conpty.node"]) assert.ok(packed.files.some((file) => file.path === required), `Missing bundled native file: ${required}`);
  if (native.build) for (const file of Object.keys(native.build.files)) assert.ok(packed.files.some((entry) => entry.path === `node_modules/node-pty/prebuilds/linux-x64/${file}`), `Missing maintainer-built native file: ${file}`);
  assert.deepEqual(sourceIdentity(root), identity, "Source changed while packing");
  const receipt = { schema: 1, commit, ...identity, version: manifest.version, filename: packed.filename, sha256: digest(path.join(output, packed.filename)), lockSha256: digest(path.join(root, "pnpm-lock.yaml")), native, node: process.version, platform: process.platform, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT };
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  await sbom(staging, path.join(output, "package.cdx.json"), ["node-pty", "node-addon-api"]);
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `sha256=${receipt.sha256}\n`);
  console.log(`Verified package: ${path.join(output, packed.filename)} (${receipt.sha256})`);
} catch (error) { cleanupFailed = error.cleanupFailed === true; throw error; }
finally {
  assert.equal(path.dirname(staging), tmpdir());
  assert.ok(path.basename(staging).startsWith("everpeace-pack-"));
  if (!cleanupFailed) await fs.rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
