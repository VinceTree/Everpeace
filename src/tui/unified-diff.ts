export type DiffLineKind =
  | "addition"
  | "context"
  | "deletion"
  | "file"
  | "hunk"
  | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  newLine?: number;
  oldLine?: number;
  text: string;
}

export interface UnifiedDiff {
  lines: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

export function parseUnifiedDiff(
  value: string,
  options: { allowPartial?: boolean } = {},
): UnifiedDiff | undefined {
  const rawLines = value.replace(/\r\n?/gu, "\n").split("\n");
  const hasFileHeader = rawLines.some(
    (line, index) => line.startsWith("--- ") && rawLines[index + 1]?.startsWith("+++ "),
  );
  const hasHunk = rawLines.some((line) => HUNK.test(line));
  const hasChanges = rawLines.some((line) => line.startsWith("+")) &&
    rawLines.some((line) => line.startsWith("-"));
  if (options.allowPartial ? !hasChanges : !hasFileHeader || !hasHunk) return undefined;

  const lines: DiffLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;
  for (const text of rawLines) {
    const hunk = HUNK.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      lines.push({ kind: "hunk", text });
    } else if (
      text.startsWith("diff --git ") || text.startsWith("index ") ||
      text.startsWith("--- ") || text.startsWith("+++ ")
    ) {
      lines.push({ kind: "file", text });
    } else if (text.startsWith("+") && (newLine !== undefined || options.allowPartial)) {
      lines.push({ kind: "addition", ...(newLine === undefined ? {} : { newLine }), text });
      if (newLine !== undefined) newLine += 1;
    } else if (text.startsWith("-") && (oldLine !== undefined || options.allowPartial)) {
      lines.push({ kind: "deletion", ...(oldLine === undefined ? {} : { oldLine }), text });
      if (oldLine !== undefined) oldLine += 1;
    } else if (text.startsWith(" ") && oldLine !== undefined && newLine !== undefined) {
      lines.push({ kind: "context", oldLine, newLine, text });
      oldLine += 1;
      newLine += 1;
    } else {
      lines.push({ kind: "meta", text });
    }
  }
  return { lines };
}

export function diffLanguage(value: string): string | undefined {
  const match = /^(?:diff --git a\/(.+?) b\/(?:.+)|\+\+\+ (?:b\/)?(.+))$/mu.exec(value);
  const filename = match?.[1] ?? match?.[2];
  const extension = filename?.split(".").at(-1)?.toLowerCase();
  return {
    cjs: "javascript",
    cs: "csharp",
    js: "javascript",
    jsx: "jsx",
    md: "markdown",
    mjs: "javascript",
    ps1: "powershell",
    py: "python",
    sh: "bash",
    ts: "typescript",
    tsx: "tsx",
    yml: "yaml",
  }[extension ?? ""];
}
