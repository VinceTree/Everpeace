/** Terminal cell-width measurement and truncation helpers. */
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function graphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

export function characterWidth(character: string): number {
  if (/^\p{Mark}+$/u.test(character)) return 0;
  if (/\p{Extended_Pictographic}/u.test(character)) return 2;

  const codePoint = character.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  )
    ? 2
    : 1;
}

export function textWidth(value: string | readonly string[]): number {
  const characters = typeof value === "string" ? graphemes(value) : value;
  return characters.reduce(
    (width, character) => width + characterWidth(character),
    0,
  );
}

function takeStart(value: string, maximumWidth: number): string {
  let width = 0;
  const output: string[] = [];
  for (const character of graphemes(value)) {
    const nextWidth = characterWidth(character);
    if (width + nextWidth > maximumWidth) break;
    output.push(character);
    width += nextWidth;
  }
  return output.join("");
}

function takeEnd(value: string, maximumWidth: number): string {
  let width = 0;
  const output: string[] = [];
  const characters = graphemes(value);
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    const nextWidth = characterWidth(character);
    if (width + nextWidth > maximumWidth) break;
    output.unshift(character);
    width += nextWidth;
  }
  return output.join("");
}

export function truncateEnd(value: string, maximumWidth: number): string {
  if (maximumWidth <= 0) return "";
  if (textWidth(value) <= maximumWidth) return value;
  if (maximumWidth === 1) return "…";
  return `${takeStart(value, maximumWidth - 1)}…`;
}

export function truncateMiddle(value: string, maximumWidth: number): string {
  if (maximumWidth <= 0) return "";
  if (textWidth(value) <= maximumWidth) return value;
  if (maximumWidth === 1) return "…";

  const contentWidth = maximumWidth - 1;
  const startWidth = Math.ceil(contentWidth / 2);
  const endWidth = Math.floor(contentWidth / 2);
  return `${takeStart(value, startWidth)}…${takeEnd(value, endWidth)}`;
}

export function padEndToWidth(value: string, width: number): string {
  const fitted = truncateEnd(value, width);
  return `${fitted}${" ".repeat(Math.max(0, width - textWidth(fitted)))}`;
}
