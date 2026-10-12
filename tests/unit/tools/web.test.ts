import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchWebPage,
  isPublicIpAddress,
  parseBingResults,
  parseDuckDuckGoResults,
  parseWebFetchUrl,
  parseWebSearchQuery,
  searchWeb,
} from "../../../src/tools/web.js";

const searchFixture = `
  <div class="result results_links results_links_deep web-result ">
    <a class="result__a" href="https://example.com/news">Example &amp; News</a>
    <a class="result__snippet" href="https://example.com/news">A <b>current</b> result.</a>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fguide">Guide</a>
    <div class="result__snippet">Useful guide</div>
  </div>`;

const bingFixture = `
  <ol id="b_results">
    <li class="b_algo" data-id="SERP.1">
      <h2><a target="_blank" href="https://example.com/news">Example &amp; News</a></h2>
      <div class="b_caption"><p>A <strong>current</strong> result.</p></div>
    </li>
    <li class="b_algo" data-id="SERP.2">
      <h2><a href="https://example.org/guide">Guide</a></h2>
      <div class="b_caption"><p>Useful guide</p></div>
    </li>
  </ol>`;

test("web tool arguments require a non-empty bounded string", () => {
  assert.equal(parseWebSearchQuery('{"query":" latest news "}'), "latest news");
  assert.equal(parseWebSearchQuery('{"query":""}'), undefined);
  assert.equal(parseWebSearchQuery("not json"), undefined);
  assert.equal(parseWebFetchUrl('{"url":"https://example.com"}'), "https://example.com");
});

test("DuckDuckGo HTML results are converted to source records", () => {
  assert.deepEqual(parseDuckDuckGoResults(searchFixture), [
    {
      title: "Example & News",
      url: "https://example.com/news",
      snippet: "A current result.",
    },
    {
      title: "Guide",
      url: "https://example.org/guide",
      snippet: "Useful guide",
    },
  ]);
});

test("Bing HTML results are converted to source records", () => {
  assert.deepEqual(parseBingResults(bingFixture), [
    {
      title: "Example & News",
      url: "https://example.com/news",
      snippet: "A current result.",
    },
    {
      title: "Guide",
      url: "https://example.org/guide",
      snippet: "Useful guide",
    },
  ]);
});

test("searchWeb sends the query and returns parsed results", async () => {
  let requestedUrl = "";
  const fetchMock = (async (input: URL | RequestInfo) => {
    requestedUrl = String(input);
    return new Response(bingFixture, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;

  const result = await searchWeb("latest news", { fetch: fetchMock, lookup: async () => [{ address: "8.8.8.8", family: 4 }] });

  assert.match(requestedUrl, /q=latest\+news/u);
  assert.equal(result.query, "latest news");
  assert.equal(result.results.length, 2);
});

test("search fallback keeps time for Bing China when the first provider times out", async () => {
  const requested: string[] = [];
  const fetchMock = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    requested.push(url.hostname);
    assert.equal(init?.redirect, "manual");
    if (url.hostname === "www.bing.com") {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    assert.equal(init?.signal?.aborted, false);
    return new Response(bingFixture, { status: 200 });
  }) as typeof fetch;
  // AbortSignal.timeout is unref'ed; keep this controlled timeout test alive.
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    const result = await searchWeb("latest news", { fetch: fetchMock, timeoutMs: 300, lookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    assert.deepEqual(requested, ["www.bing.com", "cn.bing.com"]);
    assert.equal(result.results.length, 2);
  } finally { clearTimeout(keepAlive); }
});

test("search validates redirect destinations before following them", async () => {
  const requested: string[] = [];
  const fetchMock = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    requested.push(url.hostname);
    if (url.hostname === "html.duckduckgo.com") return new Response(searchFixture);
    return new Response("redirect body", { status: 302, headers: { location: "http://127.0.0.1/private" } });
  }) as typeof fetch;
  const result = await searchWeb("latest news", { fetch: fetchMock, lookup: async () => [{ address: "8.8.8.8", family: 4 }] });
  assert.deepEqual(requested, ["www.bing.com", "cn.bing.com", "html.duckduckgo.com"]);
  assert.equal(result.results.length, 2);
});

test("search cancellation prevents starting fallback providers", async () => {
  const controller = new AbortController();
  let requests = 0;
  const fetchMock = (async () => {
    requests += 1;
    controller.abort(new Error("User cancelled search"));
    throw controller.signal.reason;
  }) as typeof fetch;
  await assert.rejects(searchWeb("latest news", { fetch: fetchMock, signal: controller.signal, lookup: async () => [{ address: "8.8.8.8", family: 4 }] }), /User cancelled search/);
  assert.equal(requests, 1);
});

test("fetchWebPage extracts readable text from a public HTML page", async () => {
  const requestedUrls: string[] = [];
  const fetchMock = (async (input: URL | RequestInfo) => {
    requestedUrls.push(String(input));
    return new Response(
      "<html><head><title>Example</title><style>hidden</style></head>" +
        "<body><main><h1>Hello</h1><p>Useful &amp; current.</p>" +
        "<script>ignore()</script></main></body></html>",
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }) as typeof fetch;

  const result = await fetchWebPage("https://example.com/article", {
    fetch: fetchMock,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  });

  assert.deepEqual(requestedUrls, ["https://example.com/article"]);
  assert.equal(result.title, "Example");
  assert.match(result.content, /^# Hello\n\nUseful & current\./u);
  assert.doesNotMatch(result.content, /hidden|ignore/u);
  assert.equal(result.truncated, false);
});

test("fetchWebPage validates every redirect target", async () => {
  let requests = 0;
  const fetchMock = (async () => {
    requests += 1;
    return new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/private" },
    });
  }) as typeof fetch;

  await assert.rejects(
    fetchWebPage("https://example.com", {
      fetch: fetchMock,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    }),
    /Local and private network addresses/u,
  );
  assert.equal(requests, 1);
});

test("page navigation retains bounded real links resolved against the final URL without following them", async () => {
  const fetched: string[] = [];
  const html = '<base href="https://injected.invalid/">' +
    '<a href="../help/example-domains">Example &amp; domains</a>' +
    '<a href="../help/example-domains">Duplicate</a>' +
    '<a href="javascript:alert(1)">Script</a><a href="https://user:secret@example.org/">Secret</a>' +
    '<script><a href="https://script.invalid/">Hidden</a></script>' +
    '<a href="#local">Fragment</a>' +
    Array.from({ length: 50 }, (_, i) => `<a href='/page-${i}'>Page ${i}</a>`).join('');
  const result = await fetchWebPage("https://example.org/redirect", {
    fetch: (async (input) => {
      fetched.push(String(input));
      if (fetched.length === 1) return new Response(null, { status: 302, headers: { location: '/domains/index' } });
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    }) as typeof fetch,
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  });
  assert.deepEqual(fetched, ['https://example.org/redirect', 'https://example.org/domains/index']);
  assert.deepEqual(result.links?.[0], { title: 'Example & domains', url: 'https://example.org/help/example-domains' });
  assert.equal(result.links?.length, 40);
  assert.ok(result.links?.every(link => link.url.startsWith('https://example.org/') && !link.url.includes('secret')));
});

test("private and local IP addresses are blocked", async () => {
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("127.0.0.1"), false);
  assert.equal(isPublicIpAddress("10.0.0.1"), false);
  assert.equal(isPublicIpAddress("::1"), false);
  assert.equal(isPublicIpAddress("::ffff:127.0.0.1"), false);

  await assert.rejects(fetchWebPage("http://192.168.1.5"), /private network/u);
});
