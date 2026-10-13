import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseDocument } from "htmlparser2";
import { selectAll, selectOne } from "css-select";
import { textContent } from "domutils";
import { marked } from "marked";
import { extractHtmlContent } from "../../src/tools/html-content.js";
import { withPublicResponse } from "../../src/network/public-http.js";

const sources = [
  ["https://nodejs.org/api/assert.html", "https://nodejs.org/api/util.html", "https://nodejs.org/api/events.html"],
  ["https://vite.dev/guide/", "https://vite.dev/guide/features", "https://vite.dev/guide/build"],
  ["https://vitest.dev/guide/", "https://vitest.dev/guide/mocking", "https://vitest.dev/guide/features"],
  ["https://pnpm.io/cli/install", "https://pnpm.io/cli/add", "https://pnpm.io/cli/update"],
  ["https://expressjs.com/en/guide/routing.html", "https://expressjs.com/en/guide/error-handling.html", "https://expressjs.com/en/guide/using-middleware.html"],
  ["https://fastify.dev/docs/latest/Reference/Server/", "https://fastify.dev/docs/latest/Reference/Routes/", "https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/"],
  ["https://svelte.dev/docs/svelte/overview", "https://svelte.dev/docs/svelte/what-are-runes", "https://svelte.dev/docs/svelte/lifecycle-hooks"],
  ["https://prettier.io/docs/options", "https://prettier.io/docs/cli", "https://prettier.io/docs/configuration"],
].flat();
interface Page { file: string; source: string; finalUrl: string; at: string; sha256: string; bodySelector: string | null; relevant: string[]; noise: string[]; code: string[]; links: string[]; staticBodyAvailable: boolean }
interface Failure { source: string; error: string }
const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();

export async function prepareRealWeb(root: string, previousRoot?: string): Promise<void> {
  await mkdir(root);
  const pages: Page[] = [];
  const failures: Failure[] = [];
  const previous = previousRoot ? JSON.parse(await readFile(path.join(previousRoot, "manifest.json"), "utf8")) as { pages: Page[] } : undefined;
  for (const [index, source] of sources.entries()) {
    try {
    const reusable = previous?.pages.find(page => page.source === source);
    if (reusable && previousRoot) {
      const html = await readFile(path.join(previousRoot, reusable.file), "utf8");
      assert.equal(createHash("sha256").update(html).digest("hex"), reusable.sha256);
      await writeFile(path.join(root, reusable.file), html, { flag: "wx" });
      pages.push(reusable);
      await appendFile(path.join(root, "pages.jsonl"), JSON.stringify(reusable) + "\n");
      continue;
    }
    let target = new URL(source), html = "";
    for (let redirects = 0; redirects <= 5; redirects++) {
      const result = await withPublicResponse(target, { signal: AbortSignal.timeout(15000) }, {}, async response => {
        if ([301, 302, 303, 307, 308].includes(response.status)) return { location: response.headers.get("location") };
        assert.equal(response.status, 200);
        const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; assert.ok(size <= 3 * 1024 * 1024, "Snapshot too large"); chunks.push(chunk.value); } }
        finally { await reader.cancel(); reader.releaseLock(); }
        return { html: Buffer.concat(chunks).toString("utf8") };
      });
      if (result.html !== undefined) { html = result.html; break; }
      assert.ok(result.location && redirects < 5, "Redirect unavailable"); target = new URL(result.location, target);
    }
    const url = target.href;
    const document = parseDocument(html);
    const bodySelector = [".vp-doc", ".theme-doc-markdown", "article", "main", "#apicontent"].find(selector => selectOne(selector, document) && normalize(textContent(selectOne(selector, document)!)).length > 200) ?? null;
    const body = bodySelector ? selectOne(bodySelector, document)! : document;
    const relevant = bodySelector ? [...new Set(selectAll("h1,h2,h3,p,li,pre,tr", body).map(textContent).map(normalize).filter(value => value.length > 20))] : [];
    const noise = [...new Set(selectAll("nav,footer,aside", document).map(textContent).map(normalize).filter(value => value.length > 20 && !relevant.some(block => block.includes(value))))];
    const file = String(index + 1).padStart(2, "0") + ".html";
    await writeFile(path.join(root, file), html, { flag: "wx" });
    const links = [...new Set(selectAll("a[href]", body).flatMap(element => {
      if (!("attribs" in element) || typeof element.attribs !== "object" || !element.attribs) return [];
      const href = (element.attribs as Record<string, string>).href;
      if (!href || href.startsWith("#")) return [];
      try { const link = new URL(href, url); return /^https?:$/u.test(link.protocol) ? [link.href] : []; } catch { return []; }
    }))].slice(0, 40);
    pages.push({ file, source, finalUrl: url, at: new Date().toISOString(), sha256: createHash("sha256").update(html).digest("hex"), bodySelector, relevant, noise, code: selectAll("pre", body).map(textContent), links, staticBodyAvailable: relevant.length > 0 });
    console.log(JSON.stringify({ source, blocks: relevant.length, code: pages.at(-1)!.code.length, selector: bodySelector }));
    await appendFile(path.join(root, "pages.jsonl"), JSON.stringify(pages.at(-1)) + "\n");
    } catch (error) {
      const failure = { source, error: error instanceof Error ? error.name : "unknown" };
      failures.push(failure);
      await appendFile(path.join(root, "failures.jsonl"), JSON.stringify(failure) + "\n");
      console.log(JSON.stringify(failure));
    }
  }
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({ schema: 1, planned: sources, failures, ...(previousRoot ? { previousRoot } : {}), kind: "public-web-snapshots-local-evaluation-only", annotationMethod: "Independent DOM block references; selector annotations require host review before publication", pages }, null, 2), { flag: "wx" });
}

export async function proveRealWeb(root: string) {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as { planned: string[]; pages: Page[]; failures: Failure[] };
  assert.equal(manifest.planned.length, 24);
  assert.equal(manifest.pages.length + manifest.failures.length, 24);
  assert.equal(new Set(manifest.planned.map(source => new URL(source).hostname)).size, 8);
  const pages = [];
  for (const page of manifest.pages) {
    const html = await readFile(path.join(root, page.file), "utf8");
    assert.equal(createHash("sha256").update(html).digest("hex"), page.sha256);
    const extracted = extractHtmlContent(html, new URL(page.finalUrl));
    const plain = normalize(textContent(parseDocument(marked.parse(extracted.content) as string)));
    const found = page.relevant.filter(block => plain.includes(block)).length;
    const irrelevant = page.noise.filter(block => plain.includes(block)).length;
    const precision = found + irrelevant ? found / (found + irrelevant) : null;
    const recall = page.relevant.length ? found / page.relevant.length : null;
    pages.push({ source: page.source, sha256: page.sha256, referenceBlocks: page.relevant.length, found, irrelevant, annotatedPrecision: precision, annotatedRecall: recall, exactCode: page.code.filter(code => extracted.content.includes(code.replaceAll("\r\n", "\n"))).length, codeBlocks: page.code.length, retainedLinks: page.links.filter(url => extracted.links.some(link => link.url === url)).length, referenceLinks: page.links.length, staticBodyAvailable: page.staticBodyAvailable, extractionTruncated: extracted.extractionTruncated });
  }
  const shell = extractHtmlContent('<html><body><div id="app"></div><script>document.querySelector("#app").textContent="dynamic article"</script></body></html>', new URL("https://example.com"));
  assert.equal(shell.content, "");
  const truncated = extractHtmlContent("<div>".repeat(80) + "deep body" + "</div>".repeat(80), new URL("https://example.com"));
  assert.equal(truncated.extractionTruncated, true);
  const report = { schema: 1, modelRequests: 0, planned: 24, downloaded: pages.length, failures: manifest.failures, annotationReview: "required before any accuracy claim", shellAndDepthControls: { jsExecuted: false, shellBodyEmpty: true, deepBodyTruncationDetected: true }, scope: "24 planned public technical pages on 8 sites; sampled DOM references, not general-web precision or browser-rendered coverage", pages };
  await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, directory, previousDirectory] = process.argv.slice(2);
  if (!directory || !path.isAbsolute(directory)) throw Error("Supply a new absolute snapshot directory");
  if (mode === "prepare") await prepareRealWeb(directory, previousDirectory);
  else if (mode === "prove") console.log(JSON.stringify(await proveRealWeb(directory)));
  else throw Error("Choose prepare or prove");
}
