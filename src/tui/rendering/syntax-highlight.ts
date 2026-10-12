/** Bounded syntax highlighting for terminal-safe rich text. */
import { all, createLowlight } from "lowlight";

export const MAX_HIGHLIGHT_BYTES = 512 * 1024;
export const MAX_HIGHLIGHT_LINES = 10_000;
export const MAX_HIGHLIGHT_LINE_BYTES = 4 * 1024;

export interface StyledSpan {
  bold?: boolean;
  color?: string;
  dim?: boolean;
  italic?: boolean;
  text: string;
}

interface HastNode {
  type: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

const highlighter = createLowlight(all);

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  csharp: "csharp",
  cs: "csharp",
  html: "html",
  js: "javascript",
  jsx: "jsx",
  md: "markdown",
  ps: "powershell",
  ps1: "powershell",
  pwsh: "powershell",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  tsx: "tsx",
  yml: "yaml",
};

function styleForClasses(classes: readonly string[]): Omit<StyledSpan, "text"> {
  const names = new Set(classes.map((name) => name.replace(/^hljs-/u, "")));
  if (names.has("comment") || names.has("quote")) return { color: "gray", dim: true };
  if (names.has("deletion")) return { color: "red" };
  if (names.has("addition")) return { color: "green" };
  if (
    names.has("keyword") || names.has("selector-tag") ||
    names.has("literal") || names.has("section")
  ) return { color: "magenta" };
  if (
    names.has("string") || names.has("title") || names.has("name") ||
    names.has("type") || names.has("attribute") || names.has("symbol") ||
    names.has("bullet")
  ) return { color: "green" };
  if (names.has("number") || names.has("meta")) return { color: "yellow" };
  if (names.has("built_in") || names.has("selector-class")) return { color: "cyan" };
  if (
    names.has("variable") || names.has("template-variable") ||
    names.has("regexp")
  ) return { color: "red" };
  if (names.has("strong")) return { bold: true };
  if (names.has("emphasis")) return { italic: true };
  return {};
}

function collectSpans(
  node: HastNode,
  inherited: Omit<StyledSpan, "text">,
  output: StyledSpan[],
): void {
  if (node.type === "text") {
    if (node.value) output.push({ ...inherited, text: node.value });
    return;
  }
  const className = node.properties?.className;
  const classes = Array.isArray(className)
    ? className.filter((value): value is string => typeof value === "string")
    : [];
  const style = { ...inherited, ...styleForClasses(classes) };
  node.children?.forEach((child) => collectSpans(child, style, output));
}

function plainLines(code: string): StyledSpan[][] {
  return code.split("\n").map((text) => [{ text: text || " " }]);
}

export function normalizeLanguage(language: string | undefined): string | undefined {
  const normalized = language?.trim().toLowerCase().split(/\s+/u)[0];
  if (!normalized) return undefined;
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

export function canHighlight(code: string): boolean {
  if (Buffer.byteLength(code, "utf8") > MAX_HIGHLIGHT_BYTES) return false;
  const lines = code.split("\n");
  return lines.length <= MAX_HIGHLIGHT_LINES &&
    lines.every((line) => Buffer.byteLength(line, "utf8") <= MAX_HIGHLIGHT_LINE_BYTES);
}

export function highlightCode(
  code: string,
  language?: string,
): StyledSpan[][] {
  const normalized = normalizeLanguage(language);
  if (!normalized || !canHighlight(code) || !highlighter.registered(normalized)) {
    return plainLines(code);
  }
  try {
    const root = highlighter.highlight(normalized, code) as HastNode;
    const spans: StyledSpan[] = [];
    collectSpans(root, {}, spans);
    const lines: StyledSpan[][] = [[]];
    for (const span of spans) {
      const parts = span.text.split("\n");
      parts.forEach((part, index) => {
        if (part) lines.at(-1)!.push({ ...span, text: part });
        if (index < parts.length - 1) lines.push([]);
      });
    }
    return lines.map((line) => line.length ? line : [{ text: " " }]);
  } catch {
    return plainLines(code);
  }
}

export function shellLanguage(shell: string): string {
  return /powershell|pwsh/u.test(shell.toLowerCase()) ? "powershell" : "bash";
}
