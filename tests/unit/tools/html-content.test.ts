import test from "node:test";
import assert from "node:assert/strict";
import { extractHtmlContent } from "../../../src/tools/html-content.js";
import { proveWebContent } from "../../fixtures/prove-web-content.js";

test("frozen technical documents retain annotated blocks, exact code and tables", async () => { await proveWebContent(); });
test("structured extraction ignores base, hidden contents and active elements", () => {
  const result = extractHtmlContent('<title>Example</title><base href="http://bad.invalid/"><body><nav>noise</nav><article><h2>Technical content</h2><p>Text <a href="../api">API</a>.</p><ul><li>First item</li></ul><blockquote>Quoted data</blockquote><pre><code class="language-ts">  const a = 1;\n\n    console.log(a);\n</code></pre><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td><a href="/two">2</a></td></tr></table><div hidden>private</div><div style="display:none!important">secret</div><form>form</form><script>code</script></article></body>', new URL("https://docs.example/guide/page"));
  assert.match(result.content, /## Technical content/u); assert.match(result.content, /- First item/u); assert.match(result.content, /> Quoted data/u);
  assert.match(result.content, /```ts\n  const a = 1;\n\n    console.log\(a\);\n```/u);
  assert.match(result.content, /A \| B/u); assert.match(result.content, /1 \| \[2\]/u);
  assert.doesNotMatch(result.content, /noise|private|secret|form|bad\.invalid/u);
  assert.equal(result.links[0]?.url, "https://docs.example/api");
});
test("excessive nesting and tables report truncation instead of silent loss", () => {
  const nested = extractHtmlContent("<div>".repeat(80) + "text" + "</div>".repeat(80), new URL("https://docs.example/")); assert.equal(nested.extractionTruncated, true);
  const table = extractHtmlContent("<table>" + "<tr><td>cell</td></tr>".repeat(501) + "</table>", new URL("https://docs.example/")); assert.equal(table.extractionTruncated, true);
});
