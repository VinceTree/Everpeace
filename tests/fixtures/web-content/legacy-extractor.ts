// Frozen predecessor; used only to compare extraction on the same inputs.
const PAGE_LINK_LIMIT = 40;
function decodeHtml(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    mdash: "—",
    nbsp: " ",
    ndash: "–",
    quot: '"',
    rdquo: "”",
    rsquo: "’",
  };

  return value.replace(
    /&(#x[\da-f]+|#\d+|[a-z]+);/giu,
    (entity, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        const codePoint = Number.parseInt(body.slice(2), 16);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      if (body.startsWith("#")) {
        const codePoint = Number.parseInt(body.slice(1), 10);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      return namedEntities[body.toLowerCase()] ?? entity;
    },
  );
}

function htmlFragmentToText(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
}

export function legacyHtmlToPageText(html: string, pageUrl: URL): { title: string | null; content: string; links: Array<{ title: string; url: string }> } {
  const titleMatch = html.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/iu);
  const title = titleMatch ? htmlFragmentToText(titleMatch[1] ?? "") || null : null;
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(script|style|noscript|svg|template|object)[^>]*>[\s\S]*?<\/\1>/giu, " ")
    .replace(/<head[^>]*>[\s\S]*?<\/head>/giu, " ");
  const links: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  for (const match of cleaned.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu)) {
    const href = match[1]!.match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu);
    const raw = decodeHtml(href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
    const title = htmlFragmentToText(match[2]!).slice(0, 200);
    if (!raw || raw.startsWith("#") || !title) continue;
    let url: URL;
    try { url = new URL(raw, pageUrl); } catch { continue; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 2048) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href); links.push({ title, url: url.href });
    if (links.length === PAGE_LINK_LIMIT) break;
  }
  const withoutNoise = cleaned
    .replace(/<(?:br|hr)\s*\/?\s*>/giu, "\n")
    .replace(/<\/(?:article|aside|blockquote|div|footer|h[1-6]|header|li|main|nav|p|pre|section|table|tr)>/giu, "\n")
    .replace(/<li[^>]*>/giu, "- ")
    .replace(/<[^>]*>/gu, " ");
  const content = decodeHtml(withoutNoise)
    .replace(/\r/gu, "")
    .replace(/[\t ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return { title, content, links };
}
