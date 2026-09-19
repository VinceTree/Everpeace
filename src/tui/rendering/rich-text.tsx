import { Box, Text, useWindowSize } from "ink";
import { marked } from "marked";
import React, { Fragment, type ReactNode } from "react";
import { diffPalette, TUI_COLORS } from "./palette.js";
import { highlightCode, shellLanguage, type StyledSpan } from "./syntax-highlight.js";
import { diffLanguage, parseUnifiedDiff, type UnifiedDiff } from "./unified-diff.js";

interface MarkdownToken {
  type: string;
  text?: string;
  raw?: string;
  depth?: number;
  lang?: string;
  href?: string;
  tokens?: MarkdownToken[];
  items?: MarkdownToken[];
  header?: MarkdownTableCell[];
  rows?: MarkdownTableCell[][];
  ordered?: boolean;
  start?: number;
  checked?: boolean;
  task?: boolean;
}

interface MarkdownTableCell {
  text?: string;
  tokens?: MarkdownToken[];
}

function StyledLine({ spans }: { spans: StyledSpan[] }) {
  return (
    <Text wrap="truncate-end">
      {spans.map((span, index) => (
        <Text
          key={`${index}:${span.text}`}
          {...(span.color ? { color: span.color } : {})}
          {...(span.bold === undefined ? {} : { bold: span.bold })}
          {...(span.dim === undefined ? {} : { dimColor: span.dim })}
          {...(span.italic === undefined ? {} : { italic: span.italic })}
        >
          {span.text}
        </Text>
      ))}
    </Text>
  );
}

export function HighlightedCode({
  code,
  language,
  label,
  marginLeft = 0,
}: {
  code: string;
  language?: string;
  label?: string;
  marginLeft?: number;
}) {
  const lines = highlightCode(code.replace(/\n$/u, ""), language);
  const gutterWidth = String(lines.length).length;
  return (
    <Box flexDirection="column" marginLeft={marginLeft}>
      {label || language ? (
        <Text dimColor>{label ?? language}</Text>
      ) : null}
      {lines.map((spans, index) => (
        <Box key={index} height={1} flexWrap="nowrap" overflow="hidden">
          <Text dimColor>{String(index + 1).padStart(gutterWidth)} │ </Text>
          <StyledLine spans={spans} />
        </Box>
      ))}
    </Box>
  );
}

export function HighlightedCommand({ command, shell }: { command: string; shell: string }) {
  const lines = highlightCode(command, shellLanguage(shell));
  return (
    <Box flexDirection="column" marginLeft={2}>
      {lines.map((spans, index) => (
        <Box key={index} height={1} overflow="hidden">
          <StyledLine spans={spans} />
        </Box>
      ))}
    </Box>
  );
}

export function DiffView({ diff, marginLeft = 0 }: { diff: UnifiedDiff; marginLeft?: number }) {
  const palette = diffPalette();
  const language = diffLanguage(diff.lines.map((line) => line.text).join("\n"));
  const maximum = Math.max(
    1,
    ...diff.lines.flatMap((line) => [line.oldLine ?? 0, line.newLine ?? 0]),
  );
  const gutterWidth = String(maximum).length;
  return (
    <Box flexDirection="column" marginLeft={marginLeft}>
      {diff.lines.map((line, index) => {
        const addition = line.kind === "addition";
        const deletion = line.kind === "deletion";
        const header = line.kind === "file" || line.kind === "hunk";
        const content = addition || deletion ? line.text.slice(1) : line.text;
        const spans = addition || deletion
          ? highlightCode(content, language)[0] ?? [{ text: content || " " }]
          : [{ text: content || " " }];
        const oldNumber = line.oldLine === undefined ? "" : String(line.oldLine);
        const newNumber = line.newLine === undefined ? "" : String(line.newLine);
        const marker = addition ? "+" : deletion ? "-" : header ? "◆" : " ";
        const foreground = addition
          ? palette.addedForeground
          : deletion
            ? palette.deletedForeground
            : header
              ? palette.headerForeground
              : undefined;
        const background = addition
          ? palette.addedBackground
          : deletion
            ? palette.deletedBackground
            : undefined;
        return (
          <Box
            key={`${index}:${line.text}`}
            height={1}
            flexWrap="nowrap"
            overflow="hidden"
            {...(background ? { backgroundColor: background } : {})}
          >
            <Text dimColor>{oldNumber.padStart(gutterWidth)} {newNumber.padStart(gutterWidth)} │ </Text>
            <Text bold={header} {...(foreground ? { color: foreground } : {})}>{marker} </Text>
            {addition || deletion
              ? <StyledLine spans={spans.map((span) => span.color || !foreground ? span : { ...span, color: foreground })} />
              : <Text {...(foreground ? { color: foreground } : {})}>{content || " "}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}

export function RichOutput({
  text,
  marginLeft = 0,
  maximumLines,
  range,
}: {
  text: string;
  marginLeft?: number;
  maximumLines?: { head: number; tail: number };
  range?: { count: number; start: number };
}) {
  const diff = parseUnifiedDiff(text);
  if (diff) {
    const omitted = maximumLines && diff.lines.length > maximumLines.head + maximumLines.tail
      ? diff.lines.length - maximumLines.head - maximumLines.tail
      : 0;
    let selected = omitted > 0 && maximumLines
      ? {
          lines: [
            ...diff.lines.slice(0, maximumLines.head),
            { kind: "meta" as const, text: `… ${omitted} lines omitted (/outputs)` },
            ...diff.lines.slice(-maximumLines.tail),
          ],
      }
      : diff;
    if (range) selected = { lines: selected.lines.slice(range.start, range.start + range.count) };
    return <DiffView diff={selected} marginLeft={marginLeft} />;
  }
  const rawLines = text.split("\n");
  const omitted = maximumLines && rawLines.length > maximumLines.head + maximumLines.tail
    ? rawLines.length - maximumLines.head - maximumLines.tail
    : 0;
  let lines = omitted > 0 && maximumLines
    ? [
        ...rawLines.slice(0, maximumLines.head),
        `… ${omitted} lines omitted (/outputs)`,
        ...rawLines.slice(-maximumLines.tail),
    ]
    : rawLines;
  if (range) lines = lines.slice(range.start, range.start + range.count);
  return (
    <Box flexDirection="column" marginLeft={marginLeft}>
      {lines.map((line, index) => (
        <Box key={`${index}:${line}`} height={1} overflow="hidden">
          <Text dimColor wrap="truncate-end">{line || " "}</Text>
        </Box>
      ))}
    </Box>
  );
}

function InlineTokens({ tokens }: { tokens: readonly MarkdownToken[] }) {
  return (
    <Text wrap="wrap">
      {tokens.map((token, index): ReactNode => {
        const key = `${index}:${token.type}:${token.raw ?? token.text ?? ""}`;
        if (token.type === "strong") return <Text key={key} bold><InlineTokens tokens={token.tokens ?? []} /></Text>;
        if (token.type === "em") return <Text key={key} italic><InlineTokens tokens={token.tokens ?? []} /></Text>;
        if (token.type === "del") return <Text key={key} strikethrough><InlineTokens tokens={token.tokens ?? []} /></Text>;
        if (token.type === "codespan") return <Text key={key} color={TUI_COLORS.status}>{token.text}</Text>;
        if (token.type === "link") return <Text key={key} color={TUI_COLORS.status} underline><InlineTokens tokens={token.tokens ?? []} />{token.href ? ` (${token.href})` : ""}</Text>;
        if (token.type === "image") return <Text key={key} color={TUI_COLORS.status}>{token.text ? `[Image: ${token.text}]` : "[Image]"}{token.href ? ` (${token.href})` : ""}</Text>;
        if (token.type === "br") return <Text key={key}>{"\n"}</Text>;
        if (token.tokens?.length) return <InlineTokens key={key} tokens={token.tokens} />;
        return <Fragment key={key}>{token.text ?? token.raw ?? ""}</Fragment>;
      })}
    </Text>
  );
}

function tokenText(tokens: readonly MarkdownToken[] | undefined): string {
  if (!tokens) return "";
  return tokens.map((token) => token.tokens?.length ? tokenText(token.tokens) : token.text ?? token.raw ?? "").join("");
}

function MarkdownBlocks({ tokens, depth = 0 }: { tokens: readonly MarkdownToken[]; depth?: number }) {
  const { columns } = useWindowSize();
  return (
    <>
      {tokens.map((token, index): ReactNode => {
        const key = `${index}:${token.type}:${token.raw?.slice(0, 24) ?? ""}`;
        if (token.type === "space") return null;
        if (token.type === "heading") return <Box key={key} marginTop={index ? 1 : 0}><Text bold color={TUI_COLORS.status}>{"#".repeat(token.depth ?? 1)} </Text><InlineTokens tokens={token.tokens ?? []} /></Box>;
        if (token.type === "paragraph" || token.type === "text") return <Box key={key}><InlineTokens tokens={token.tokens ?? [{ type: "text", text: token.text ?? token.raw ?? "" }]} /></Box>;
        if (token.type === "hr") return <Text key={key} dimColor>{"─".repeat(Math.max(1, Math.min(40, columns - 6)))}</Text>;
        if (token.type === "blockquote") return <Box key={key} paddingLeft={1} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor={TUI_COLORS.secondary} flexDirection="column"><MarkdownBlocks tokens={token.tokens ?? []} depth={depth + 1} /></Box>;
        if (token.type === "list") {
          return <Box key={key} flexDirection="column">{(token.items ?? []).map((item, itemIndex) => {
            const prefix = item.task
              ? item.checked ? "[x]" : "[ ]"
              : token.ordered ? `${(token.start ?? 1) + itemIndex}.` : "•";
            const itemTokens = item.task
              ? (item.tokens ?? []).filter((child) => child.type !== "checkbox")
              : item.tokens ?? [];
            return <Box key={itemIndex} paddingLeft={depth}><Text color={TUI_COLORS.status}>{prefix} </Text><Box flexDirection="column" flexGrow={1}><MarkdownBlocks tokens={itemTokens} depth={depth + 1} /></Box></Box>;
          })}</Box>;
        }
        if (token.type === "code") {
          const code = token.text ?? "";
          const lang = token.lang?.split(/\s+/u)[0];
          const diff = lang && /^(?:diff|patch)$/iu.test(lang) ? parseUnifiedDiff(code, { allowPartial: true }) : undefined;
          return <Box key={key} marginY={1}>{diff ? <DiffView diff={diff} /> : <HighlightedCode code={code} {...(lang ? { language: lang } : {})} />}</Box>;
        }
        if (token.type === "table") {
          const headers = (token.header ?? []).map((cell) => tokenText(cell.tokens) || cell.text || "");
          const rows = token.rows ?? [];
          if (columns < 72) {
            return <Box key={key} flexDirection="column">{rows.map((row, rowIndex) => <Box key={rowIndex} flexDirection="column" marginBottom={rowIndex < rows.length - 1 ? 1 : 0}>{row.map((cell, cellIndex) => <Text key={cellIndex}><Text bold>{headers[cellIndex] ?? `Column ${cellIndex + 1}`}: </Text>{tokenText(cell.tokens) || cell.text || ""}</Text>)}</Box>)}</Box>;
          }
          return <Box key={key} flexDirection="column"><Text bold>{headers.join(" │ ")}</Text>{rows.map((row, rowIndex) => <Text key={rowIndex}>{row.map((cell) => tokenText(cell.tokens) || cell.text || "").join(" │ ")}</Text>)}</Box>;
        }
        return <Text key={key}>{token.raw ?? token.text ?? ""}</Text>;
      })}
    </>
  );
}

export function MarkdownText({ text }: { text: string }) {
  let tokens: MarkdownToken[];
  try {
    tokens = marked.lexer(text, { gfm: true }) as MarkdownToken[];
  } catch {
    return <Text wrap="wrap">{text}</Text>;
  }
  return <Box flexDirection="column"><MarkdownBlocks tokens={tokens} /></Box>;
}
