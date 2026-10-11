import assert from "node:assert/strict";
import { test } from "node:test";
import { braveSearch, SearchSettingsStore } from "../../../src/tools/search-provider.js";
import { parseBingResults, parseDuckDuckGoResults, searchWeb } from "../../../src/tools/web.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const lookup = async () => [{ address: "8.8.8.8", family: 4 }];
test("DOM search selectors tolerate reordered attributes/classes, nesting, noise and missing snippets", () => {
  const variants = [
    '<li data-extra="noise" class="extra b_algo other"><h2><span><a href="https://example.org/a" class="extra">A <b>title</b></a></span></h2><div class="other b_caption"><span>ignored</span><p>Useful <strong>text</strong></p></div></li>',
    '<li class="b_algo extra" data-extra="noise"><h2><a class="extra" href="https://example.org/a">A <b>title</b></a></h2><div class="b_caption other"><p>Useful <strong>text</strong></p></div></li>',
  ];
  for (const html of variants) assert.deepEqual(parseBingResults(`<script>untrusted()</script>${html}${html}<li>unrelated</li>`), [{ title: "A title", url: "https://example.org/a", snippet: "Useful text" }]);
  assert.deepEqual(parseDuckDuckGoResults('<div class="extra results_links result"><a href="https://example.org/b" class="extra result__a"><span>B</span></a></div>'), [{ title: "B", url: "https://example.org/b", snippet: "" }]);
  assert.deepEqual(parseBingResults('<li class=b_algo><h2><a href="javascript:bad()">Bad</a>'), []);
});
test("minimized real engine structures and their class/attribute variants preserve extraction", async () => {
  for (const [provider, parser] of [["bing", parseBingResults], ["duckduckgo", parseDuckDuckGoResults]] as const) {
    const html = await readFile(`tests/fixtures/search-html/${provider}.html`, "utf8");
    const expected = [0, 1].map((index) => ({ title: `Fixture title ${index}`, url: `https://example.org/${provider}/${index}`, snippet: `Fixture snippet ${index}` }));
    for (const variant of [html, html.replace(/class="([^"]*)"/gu, (_match, classes: string) => `data-unrelated="1" class="extra ${classes.split(" ").reverse().join(" ")}"`), `<aside><a href="https://irrelevant.example/">Noise</a></aside>${html}<script>ignored()</script>`]) assert.deepEqual(parser(variant), expected);
  }
});
test("challenge and malformed pages are inconclusive rather than successful empty searches", async () => {
  for (const html of ['<html><form>Verify you are human</form></html>', '<li class="b_algo"><h2><a>missing URL']) {
    await assert.rejects(searchWeb("fixture", { lookup, fetch: async () => new Response(html) }), /inconclusive/u);
  }
});
test("Brave protocol uses one fixed pinned HTTPS request, normalizes and deduplicates results", async () => {
  let requests = 0;
  const result = await braveSearch("fixture", "test-only", { lookup, fetch: async (input, init) => {
    requests++; const url = new URL(String(input)); assert.equal(url.origin + url.pathname, "https://api.search.brave.com/res/v1/llm/context");
    assert.equal(init?.redirect, "manual"); assert.equal(new Headers(init?.headers).get("X-Subscription-Token"), "test-only");
    const item = { title: "Fixture", url: "https://example.org/", snippets: ["one", "two"] };
    return Response.json({ grounding: { generic: [item, item, { ...item, url: "https://user:password@example.org/" }] } });
  } });
  assert.equal(requests, 1); assert.deepEqual(result.results, [{ title: "Fixture", url: "https://example.org/", snippet: "one two" }]);
});
test("Brave rejects all redirects and errors without forwarding keys or falling back", async () => {
  for (const status of [301, 302, 307, 401, 429, 500]) {
    let requests = 0; let cancelled = false;
    await assert.rejects(braveSearch("fixture", "test-only", { lookup, fetch: async () => { requests++; return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { location: "http://127.0.0.1/private" } }); } }));
    assert.equal(requests, 1); assert.equal(cancelled, true);
  }
});
test("search configuration stores only provider and auth reference and sends no validation request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "everpeace-web-settings-"));
  const secrets = new Map<string, string>();
  try {
    const file = path.join(root, "web.json");
    const settings = new SearchSettingsStore({ async set(ref, key) { secrets.set(ref, key); }, async get(ref) { return secrets.get(ref) ?? null; }, async delete(ref) { return secrets.delete(ref); } }, file);
    assert.equal(await settings.status(), "html"); await settings.configure("brave", "fixture-sensitive-value");
    const contents = await readFile(file, "utf8"); assert.equal(contents.includes("fixture-sensitive-value"), false); assert.equal(secrets.size, 1);
    await settings.configure("html"); assert.equal(await settings.status(), "html");
  } finally { await rm(root, { recursive: true, force: true }); }
});
