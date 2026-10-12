import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseDocument } from "htmlparser2";
import { selectAll, selectOne } from "css-select";
import { textContent } from "domutils";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { extractHtmlContent } from "../../src/tools/html-content.js";
import { legacyHtmlToPageText } from "./web-content/legacy-extractor.js";

const directory = new URL("./web-content/", import.meta.url);
const normalize = (value: string) => value.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1").replace(/[\p{P}\p{S}\s]+/gu, "").toLowerCase();
export async function proveWebContent() {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8")) as Array<{ file: string; source: string; sha256: string; title: string; bodyContainer: string; complex: boolean }>;
  const annotations = JSON.parse(await readFile(new URL("annotations.json", directory), "utf8")) as { noise: string[]; pages: Record<string, string[]> };
  assert.equal(manifest.length, 12);
  const pages = [];
  for (const page of manifest) {
    const html = await readFile(new URL(page.file, directory), "utf8"); assert.equal(createHash("sha256").update(html).digest("hex"), page.sha256);
    const document = parseDocument(html); const body = selectOne(page.bodyContainer, document); assert.ok(body);
    const blocks = selectAll("h1,h2,h3,h4,h5,h6,p,li,pre,tr,blockquote", body).map((element) => normalize(textContent(element))).filter(Boolean);
    const score = (content: string) => {
      const actual = normalize(content); const found = blocks.filter((block) => actual.includes(block)).length;
      const irrelevant = annotations.noise.filter((block) => actual.includes(normalize(block))).length;
      const precision = found / (found + irrelevant || 1); const recall = found / (blocks.length || 1);
      return { blocks: blocks.length, found, irrelevant, precision, recall, f1: 2 * precision * recall / (precision + recall || 1) };
    };
    const url = new URL(page.source); const previous = legacyHtmlToPageText(html, url); const current = extractHtmlContent(html, url);
    assert.equal(current.title, page.title);
    for (const block of annotations.pages[page.file]!) assert.ok(normalize(current.content).includes(normalize(block)), `Missing annotated block ${page.file}: ${block}`);
    const codeBlocks = selectAll("pre", body).map(textContent);
    for (const code of codeBlocks) assert.ok(current.content.includes(code.replaceAll("\r\n", "\n")), `Code bytes changed: ${page.file}`);
    const before = score(previous.content); const after = score(current.content); assert.ok(after.f1 >= before.f1, page.file);
    assert.equal(current.extractionTruncated, false);
    assert.ok(current.links.every((link) => !link.url.includes("invalid.example")));
    pages.push({ file: page.file, source: page.source, complex: page.complex, before, after, codeBlocks: codeBlocks.length, exactCodeBlocks: codeBlocks.length, links: current.links.length });
  }
  const complex = pages.filter((page) => page.complex); assert.ok(complex.some((page) => page.after.f1 > page.before.f1));
  return { schema: 1, corpus: "12 licensed rendered project documents with explicitly synthetic site chrome; not a general-web benchmark", metric: "F1 over annotated relevant blocks and irrelevant chrome", pages };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await proveWebContent();
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify(result) + "\n");
}
