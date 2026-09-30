export const MODEL_TOOL_OUTPUT_MAX_BYTES = 32 * 1024;

export function boundModelToolOutput(
  output: string,
  maxBytes = MODEL_TOOL_OUTPUT_MAX_BYTES,
): string {
  const encoded = Buffer.from(output, "utf8");
  if (encoded.byteLength <= maxBytes) return output;
  const omitted = encoded.byteLength - maxBytes;
  const marker = Buffer.from(`\n...[tool output truncated; at least ${omitted} bytes omitted]...\n`, "utf8");
  const contentBudget = Math.max(0, maxBytes - marker.byteLength);
  const headBytes = Math.ceil(contentBudget / 2);
  const tailBytes = Math.floor(contentBudget / 2);
  let bounded = Buffer.concat([
    encoded.subarray(0, headBytes),
    marker,
    encoded.subarray(encoded.byteLength - tailBytes),
  ]).toString("utf8");
  while (Buffer.byteLength(bounded, "utf8") > maxBytes) {
    const markerIndex = bounded.indexOf(marker.toString("utf8"));
    if (markerIndex <= 0) return bounded.slice(0, maxBytes);
    bounded = bounded.slice(0, markerIndex - 1) + bounded.slice(markerIndex);
  }
  return bounded;
}
