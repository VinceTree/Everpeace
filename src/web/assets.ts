import { access, cp, readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HarnessDesktop } from "./harness-desktop.js";

export interface BrowserAssets {
  script: Uint8Array;
  styles: Uint8Array;
}

export interface HarnessAsset {
  type: string;
  content: Uint8Array;
}

const browserTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

const sourceHarnessDirectory = new URL("../../.cache/deepseek-stock-client/public/", import.meta.url);
const sourceDesktop = new URL("../host/open-in-app.mjs", sourceHarnessDirectory);

async function isPrepared(directory: URL): Promise<boolean> {
  try {
    return (await readFile(new URL("index.html", directory), "utf8")).includes('src="./everpeace-transport.js"');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function loadPreparedHarnessAssets(directory?: string): Promise<ReadonlyMap<string, HarnessAsset> | undefined> {
  if (directory !== undefined) return loadHarnessAssets(directory);
  const bundled = new URL("./public/harness/", import.meta.url);
  for (const candidate of [bundled, sourceHarnessDirectory]) {
    if (await isPrepared(candidate)) return loadHarnessAssets(fileURLToPath(candidate));
  }
  return undefined;
}

/** Include prepared browser assets in dist without a network dependency at build time. */
export async function copyPreparedHarnessAssets(destination: string): Promise<void> {
  if (!await isPrepared(sourceHarnessDirectory)) return;
  await cp(fileURLToPath(sourceHarnessDirectory), destination, {
    recursive: true,
    filter: path => extname(path) !== ".map",
  });
}

export async function copyPreparedHarnessDesktop(destination: string): Promise<void> {
  try { await cp(sourceDesktop, destination); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export async function loadHarnessDesktop(directory?: string): Promise<HarnessDesktop | undefined> {
  const source = directory !== undefined ? pathToFileURL(resolve(directory, "../host/open-in-app.mjs"))
    : import.meta.url.endsWith(".ts") ? sourceDesktop : new URL("./host/open-in-app.mjs", import.meta.url);
  try { await access(source); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const processModule = await import(new URL(import.meta.url.endsWith(".ts") ? "./harness-desktop.ts" : "./harness-desktop.js", import.meta.url).href) as typeof import("./harness-desktop.js");
  const { createDesktop } = await import(source.href) as { createDesktop(process: typeof processModule.desktopProcess): HarnessDesktop };
  return createDesktop(processModule.desktopProcess);
}

export async function loadHarnessAssets(directory: string): Promise<ReadonlyMap<string, HarnessAsset>> {
  const assets = new Map<string, HarnessAsset>();
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    const type = browserTypes[extname(entry.name)];
    if (!entry.isFile() || !type) continue;
    const file = join(entry.parentPath, entry.name);
    const url = "/" + relative(directory, file).replaceAll("\\", "/");
    assets.set(url === "/index.html" ? "/" : url, { type, content: await readFile(file) });
  }
  assets.set("/everpeace-transport.js", {
    type: browserTypes[".js"]!, content: await loadHarnessTransport(),
  });
  if (!assets.has("/")) throw new Error("Missing DeepSeek Harness browser entry");
  return assets;
}

export async function loadHarnessTransport(): Promise<Uint8Array> {
  if (!import.meta.url.endsWith(".ts")) return readFile(new URL("./public/everpeace-transport.js", import.meta.url));
  const { build } = await import("esbuild");
  const script = await build({
    entryPoints: [fileURLToPath(new URL("./browser/harness-transport.ts", import.meta.url))],
    bundle: true, format: "iife", write: false,
  });
  return script.outputFiles[0]!.contents;
}

/** Source launches bundle in memory. Installed launches read the packaged assets. */
export async function loadBrowserAssets(): Promise<BrowserAssets> {
  if (import.meta.url.endsWith(".ts")) {
    const { build } = await import("esbuild");
    const result = await build({
      entryPoints: [fileURLToPath(new URL("./browser/index.tsx", import.meta.url))],
      outfile: "workbench.js",
      bundle: true, format: "esm", jsx: "automatic", write: false,
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const script = result.outputFiles.find(file => file.path.endsWith(".js"));
    const styles = result.outputFiles.find(file => file.path.endsWith(".css"));
    if (!script || !styles) throw new Error("Workbench browser bundle is incomplete");
    return { script: script.contents, styles: styles.contents };
  }
  const [script, styles] = await Promise.all([
    readFile(new URL("./public/workbench.js", import.meta.url)),
    readFile(new URL("./public/workbench.css", import.meta.url)),
  ]);
  return { script, styles };
}
