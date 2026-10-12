import { parseDocument } from "htmlparser2";

type DomNode = ReturnType<typeof parseDocument>["children"][number];
const NOISE = new Set(["head", "script", "style", "noscript", "svg", "template", "object", "form", "nav", "footer", "button"]);
const BLOCKS = new Set(["article", "main", "section", "div", "p", "header", "aside", "dl", "dt", "dd"]);
export interface ExtractedHtml { title: string | null; content: string; links: Array<{ title: string; url: string }>; extraction: "dom_main" | "dom_body"; extractionTruncated: boolean }
function children(node: DomNode): DomNode[] { return "children" in node ? node.children : []; }
function name(node: DomNode): string { return "name" in node ? node.name.toLowerCase() : ""; }
function attrs(node: DomNode): Record<string, string> { return "attribs" in node ? node.attribs : {}; }
function hidden(node: DomNode): boolean {
  const a = attrs(node);
  return a.hidden !== undefined || a["aria-hidden"]?.toLowerCase() === "true" || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?:\s*!important)?\s*(?:;|$)/iu.test(a.style ?? "");
}
function text(node: DomNode, onTruncated?: () => void): string {
  const stack = [{ node, depth: 0 }]; const parts: string[] = []; let visited = 0;
  while (stack.length && visited++ < 100_000) {
    const current = stack.pop()!;
    if (current.depth > 64) { onTruncated?.(); continue; }
    if (hidden(current.node) || ["script", "style", "template"].includes(name(current.node))) continue;
    if (current.node.type === "text") parts.push(current.node.data);
    else for (const child of children(current.node).slice().reverse()) stack.push({ node: child, depth: current.depth + 1 });
  }
  if (stack.length) onTruncated?.();
  return parts.join("");
}
export function extractHtmlContent(html: string, pageUrl: URL, linkLimit = 40): ExtractedHtml {
  const document = parseDocument(html);
  let title: string | null = null; let body: DomNode = document; let main: DomNode | undefined;
  const discovery = [{ node: document as DomNode, depth: 0 }]; let scanned = 0; let truncated = false;
  while (discovery.length && scanned++ < 100_000) {
    const { node, depth } = discovery.pop()!;
    if (depth > 64) { truncated = true; continue; }
    if (hidden(node)) continue;
    const tag = name(node);
    if (tag === "title" && !title) title = text(node).replace(/\s+/gu, " ").trim().slice(0, 500) || null;
    if (tag === "body") body = node;
    if (["main", "article"].includes(tag) && !main && text(node).trim().length >= 20) main = node;
    if (["script", "style", "template"].includes(tag)) continue;
    for (const child of children(node).slice().reverse()) discovery.push({ node: child, depth: depth + 1 });
  }
  if (discovery.length) truncated = true;
  const links: ExtractedHtml["links"] = []; const seen = new Set<string>(); let rendered = 0;
  const render = (node: DomNode, depth: number, inPre = false): string => {
    if (depth > 64 || rendered++ >= 100_000) { truncated = true; return ""; }
    if (hidden(node)) return "";
    if (node.type === "text") return inPre ? node.data : node.data.replace(/[\t\r\n ]+/gu, " ");
    const tag = name(node); if (NOISE.has(tag) || node.type === "comment") return "";
    const a = attrs(node);
    if (tag === "pre") {
      const value = text(node, () => { truncated = true; }).replaceAll("\r\n", "\n");
      const code = children(node).find((child) => name(child) === "code");
      const language = /(?:^|\s)language-([\w+-]+)/u.exec(attrs(code ?? node).class ?? "")?.[1] ?? "";
      const fence = "`".repeat(Math.max(3, ...[...value.matchAll(/`+/gu)].map((m) => m[0].length + 1)));
      return `\n\n${fence}${language}\n${value}${value.endsWith("\n") ? "" : "\n"}${fence}\n\n`;
    }
    if (tag === "table") {
      const rows: DomNode[] = []; const stack = children(node).slice().reverse().map((item) => ({ item, depth: depth + 1 }));
      while (stack.length && rows.length < 500 && rendered++ < 100_000) {
        const current = stack.pop()!; const item = current.item;
        if (current.depth > 64) { truncated = true; continue; }
        if (hidden(item)) continue;
        if (name(item) === "tr") rows.push(item); else stack.push(...children(item).slice().reverse().map((child) => ({ item: child, depth: current.depth + 1 })));
      }
      if (stack.length) truncated = true;
      return "\n\n" + rows.map((row) => children(row).filter((cell) => ["td", "th"].includes(name(cell))).map((cell) => render(cell, depth + 2).trim().replaceAll("|", "\\|").replace(/\n+/gu, " / ")).join(" | ")).join("\n") + "\n\n";
    }
    const content = children(node).map((child) => render(child, depth + 1, inPre)).join("");
    if (/^h[1-6]$/u.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${content.trim()}\n\n`;
    if (tag === "li") return `\n${node.parent && name(node.parent) === "ol" ? "1." : "-"} ${content.trim()}\n`;
    if (tag === "ul" || tag === "ol") return `\n${content}\n`;
    if (tag === "blockquote") return "\n\n" + content.trim().split("\n").map((line) => `> ${line}`).join("\n") + "\n\n";
    if (tag === "br") return "\n";
    if (tag === "hr") return "\n\n---\n\n";
    if (tag === "a") {
      const label = content.replace(/\s+/gu, " ").trim(); const raw = a.href?.trim();
      if (raw && !raw.startsWith("#") && label) {
        try {
          const url = new URL(raw, pageUrl);
          if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2048) {
            if (!seen.has(url.href) && links.length < linkLimit) { seen.add(url.href); links.push({ title: label.slice(0, 200), url: url.href }); }
            return `[${label.replaceAll("]", "\\]")}](${url.href.replaceAll(")", "%29")})`;
          }
        } catch { /* Unsupported or invalid links retain their visible label. */ }
      }
    }
    if (tag === "code" && !inPre) return `\`${content.replaceAll("`", "\\`")}\``;
    return BLOCKS.has(tag) ? `\n\n${content}\n\n` : content;
  };
  const lines: string[] = []; let fence: string | undefined; let blanks = 0;
  for (const line of render(main ?? body, 0).split("\n")) {
    if (fence) { lines.push(line); if (line === fence) fence = undefined; continue; }
    const opening = /^(`{3,})[^`]*$/u.exec(line);
    if (opening) { fence = opening[1]; blanks = 0; lines.push(line); }
    else if (!line.trim()) { if (++blanks <= 1) lines.push(""); }
    else { blanks = 0; lines.push(line); }
  }
  const content = lines.join("\n").trim();
  return { title, content, links, extraction: main ? "dom_main" : "dom_body", extractionTruncated: truncated };
}
