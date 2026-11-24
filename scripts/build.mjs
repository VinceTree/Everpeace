import { spawnSync } from "node:child_process";
import { access, copyFile, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

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

const browserSource = join(root, "src", "web", "assets.ts");
const hasWorkbench = await access(browserSource).then(() => true, (error) => {
  if (error.code === "ENOENT") return false;
  throw error;
});
const browser = hasWorkbench ? await import(pathToFileURL(browserSource).href) : undefined;
const assets = await browser?.loadBrowserAssets();
const harnessTransport = await browser?.loadHarnessTransport();

const require = createRequire(import.meta.url);
const compiler = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const result = spawnSync(process.execPath, [compiler, "-p", config], { cwd: root, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (process.exitCode === 0 && assets && harnessTransport) {
  const browserOutput = join(output, "web", "public");
  await mkdir(browserOutput);
  await Promise.all([
    writeFile(join(browserOutput, "workbench.js"), assets.script),
    writeFile(join(browserOutput, "workbench.css"), assets.styles),
    writeFile(join(browserOutput, "everpeace-transport.js"), harnessTransport),
    copyFile(join(root, "src", "web", "browser", "upstream", "LICENSE"), join(browserOutput, "DEEPSEEK-HARNESS-LICENSE")),
    browser.copyPreparedHarnessAssets(join(browserOutput, "harness")),
    browser.copyPreparedHarnessDesktop(join(output, "web", "host", "open-in-app.mjs")),
  ]);
}
