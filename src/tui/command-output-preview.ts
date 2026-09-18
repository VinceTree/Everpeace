import type { BashOutputPreview } from "../tools/bash.js";

export interface SelectedOutputPreview {
  headLines: string[];
  tailLines: string[];
  omittedLines: number;
}

export function selectAgentOutputPreview(
  preview: BashOutputPreview | undefined,
  visibleLineLimit: number,
): SelectedOutputPreview {
  if (!preview) {
    return { headLines: [], tailLines: [], omittedLines: 0 };
  }

  const limit = Math.max(1, Math.min(10, Math.floor(visibleLineLimit)));
  const upstreamOmitted = Math.max(0, preview.omittedLines);
  const availableLines = [...preview.headLines, ...preview.tailLines];

  if (upstreamOmitted === 0) {
    if (availableLines.length <= limit) {
      return {
        headLines: availableLines,
        tailLines: [],
        omittedLines: 0,
      };
    }
    const headCount = Math.floor(limit / 2);
    const tailCount = limit - headCount;
    return {
      headLines: availableLines.slice(0, headCount),
      tailLines: availableLines.slice(-tailCount),
      omittedLines: availableLines.length - limit,
    };
  }

  let headCount = Math.min(
    preview.headLines.length,
    Math.floor(limit / 2),
  );
  let tailCount = Math.min(
    preview.tailLines.length,
    limit - Math.floor(limit / 2),
  );
  let remaining = limit - headCount - tailCount;

  const extraTail = Math.min(
    remaining,
    preview.tailLines.length - tailCount,
  );
  tailCount += extraTail;
  remaining -= extraTail;

  const extraHead = Math.min(
    remaining,
    preview.headLines.length - headCount,
  );
  headCount += extraHead;

  return {
    headLines: preview.headLines.slice(0, headCount),
    tailLines:
      tailCount > 0 ? preview.tailLines.slice(-tailCount) : [],
    omittedLines:
      upstreamOmitted +
      preview.headLines.length -
      headCount +
      preview.tailLines.length -
      tailCount,
  };
}
