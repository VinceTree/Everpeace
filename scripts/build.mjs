import { spawnSync } from "node:child_process";
import { access, lstat, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const root = await realpath(process.cwd());
const config = join(root, "tsconfig.build.json");
await access(config);
// Resolve the fixed generated directory before recursive removal. Refuse links
// so a redirected dist never turns a build into deletion outside the checkout.
const output = join(root, "dist");
if (dirname(output) !== root) throw new Error("Build output escapes the workspace");
let metadata;
try { metadata = await lstat(output); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) throw new Error("Build output must be an ordinary dist directory");
await rm(output, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

const require = createRequire(import.meta.url);
const compiler = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const result = spawnSync(process.execPath, [compiler, "-p", config], { cwd: root, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
