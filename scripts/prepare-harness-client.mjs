import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// The npm installation supplies the browser assets and the native desktop adapter.
const upstreamVersion = "0.2.3-alpha.2";
const [modulesArg, outputArg] = process.argv.slice(2);
if (!modulesArg || !outputArg) throw new Error("Pass the upstream node_modules and output directories");
const modules = resolve(modulesArg);
const output = resolve(outputArg);
const packagePath = name => join(modules, name);
const metadata = async name => JSON.parse(await readFile(join(packagePath(name), "package.json"), "utf8"));
const upstream = async name => {
  const pkg = await metadata(name);
  if (pkg.version !== upstreamVersion) throw new Error(`Unexpected ${name} version: ${pkg.version}`);
  return pkg;
};
const importUpstream = async name => {
  const pkg = await upstream(name);
  return import(pathToFileURL(join(packagePath(name), pkg.main)).href);
};
const { bundlePatchPaths, composeEntries, loadOverlayPatches } = await importUpstream("@deepseek-ai/dsh-app-boot");
const loaderId = "@deepseek-ai/dsh-client-modules";
const { bootInjections, orderByModuleGraph } = await importUpstream(loaderId);
const layers = [];
for (const name of ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]) {
  const pkg = await upstream(name);
  layers.push(bundlePatchPaths(packagePath(name), pkg.dsh.bundle).flatMap(file => loadOverlayPatches("Everpeace web", file)));
}

const artifacts = new Map();
const entries = [];
// The upstream desktop host normally attaches this browser plugin at runtime.
const directoryPicker = { name: "@deepseek-ai/dsh-client-ui-directory-picker-native" };
for (const row of [...composeEntries(layers), directoryPicker]) {
  if (row.disabled === true || typeof row.name !== "string" || !/^@deepseek-ai\/[\w-]+$/u.test(row.name)) continue;
  const pkg = await metadata(row.name);
  const declaration = pkg.dsh?.client;
  if (declaration?.platform !== "web" || artifacts.has(row.name)) continue;
  if (pkg.version !== upstreamVersion) throw new Error(`Unexpected browser package version: ${row.name}@${pkg.version}`);
  const entry = pkg.exports["./client"];
  let content = await readFile(join(packagePath(row.name), typeof entry === "string" ? entry : entry.default), "utf8");
  if (row.name === "@deepseek-ai/dsh-client-ui-open-in-app") {
    // Image requests have no Authorization header. Use separate read-only icon URLs.
    const icon = /`\$\{OPEN_IN_APP_ICON_PREFIX_ROUTE\}\/\$\{(id|appId)\}`/gu;
    if ([...content.matchAll(icon)].length !== 2) throw new Error("Review upstream desktop icon URLs");
    content = content.replace(icon, "globalThis.__EVERPEACE_DESKTOP_ICON__($1)");
  }
  const rev = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const url = `plugins/${row.name}/client.js`;
  artifacts.set(row.name, { url, content });
  entries.push({
    id: row.name, rev, url,
    ...(declaration.inject ? { inject: declaration.inject } : {}),
    ...(declaration.external ? { external: declaration.external } : {}),
    ...(declaration.immediately === true ? { immediately: true } : {}),
  });
}
const ordered = orderByModuleGraph(entries);
const bootstrap = artifacts.get(loaderId);
if (!bootstrap) throw new Error("The upstream graph is missing its module loader");
const application = ordered.filter(entry => entry.id !== loaderId).map(entry => entry.id);
const rev = createHash("sha256").update(JSON.stringify(ordered)).digest("hex").slice(0, 16);
const graph = {
  rev, entries: ordered, batches: [
    { phase: "bootstrap", url: bootstrap.url, rev, entries: [loaderId] },
    { phase: "application", url: "harness-plugins.js", rev, entries: application },
  ],
};

const frontend = "@deepseek-ai/dsh-web-frontend";
await upstream(frontend);
await mkdir(output, { recursive: true });
await cp(join(packagePath(frontend), "dist"), output, { recursive: true });
await cp(new URL("../src/web/browser/upstream/LICENSE", import.meta.url), join(output, "DEEPSEEK-HARNESS-LICENSE"));
const html = await readFile(join(output, "index.html"), "utf8");
const shell = /<script type="module"[^>]* src="\.\/(assets\/[\w.-]+\.js)"/u.exec(html)?.[1];
if (!shell) throw new Error("The upstream web entry is missing");
const shellPath = join(output, shell);
const shellSource = await readFile(shellPath, "utf8");
// The browser graph is JSON-only. Reject loader expressions and retain the
// workbench Content Security Policy's prohibition on evaluated JavaScript.
const loaderExpression = 'new Function("ctx","expr",`\n  with (ctx) {\n    return eval(expr)\n  }\n`)';
if (shellSource.split(loaderExpression).length !== 2) throw new Error("Review upstream Cordis expression handling");
await writeFile(shellPath, shellSource.replace(loaderExpression,
  '(()=>{throw new Error("Everpeace browser plugins cannot evaluate configuration expressions")})'));
await writeFile(join(output, "harness-plugins.js"), application.map(id => artifacts.get(id).content).join("\n;\n"));
for (const [id, artifact] of artifacts) {
  const directory = join(output, "plugins", id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "client.js"), artifact.content);
  const pkg = await metadata(id);
  const assetExport = pkg.exports["./assets/*"];
  const assetRoot = typeof assetExport === "string" && /^\.\/[\w/.-]+\/\*$/u.test(assetExport) ? assetExport.slice(0, -2) : undefined;
  if (assetRoot) {
    await cp(join(packagePath(id), assetRoot), join(directory, "assets"), { recursive: true });
  }
}

const injectionTags = ['<script src="./everpeace-transport.js"></script>'];
for (const row of bootInjections(graph)) {
  if (row.kind === "script") {
    await writeFile(join(output, "harness-loader.js"), row.text);
    injectionTags.push('<script src="./harness-loader.js"></script>');
  } else if (row.kind === "script-preload") {
    injectionTags.push(`<link rel="preload" as="script" href="./${row.src}">`);
  } else if (row.kind === "script-src") {
    injectionTags.push(`<script src="./${row.src}"></script>`);
  } else if (row.kind === "global" && row.name === "__DSH_BOOT__") {
    await writeFile(join(output, "harness-graph.js"), `globalThis.__DSH_BOOT__ = ${JSON.stringify(graph)};\n`);
    injectionTags.push('<script src="./harness-graph.js"></script>');
  } else {
    throw new Error(`Unexpected upstream bootstrap instruction: ${row.kind}`);
  }
}
const firstModule = html.indexOf('<script type="module"');
if (firstModule === -1) throw new Error("The upstream web entry is missing");
await writeFile(join(output, "index.html"),
  `${html.slice(0, firstModule)}${injectionTags.join("\n    ")}\n    ${html.slice(firstModule)}`);
for (const id of ["dsh-host-open-in-app", "dsh-native-command", "dsh-subprocess"]) await upstream(`@deepseek-ai/${id}`);
await build({
  entryPoints: [fileURLToPath(new URL("./harness-desktop.mjs", import.meta.url))],
  nodePaths: [modules], outfile: join(dirname(output), "host", "open-in-app.mjs"),
  platform: "node", target: "node22", format: "esm", bundle: true, legalComments: "inline",
});
process.stdout.write(`Prepared ${ordered.length} DeepSeek Harness browser packages at ${output}\n`);
