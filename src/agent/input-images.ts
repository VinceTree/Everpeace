export const MAX_INPUT_IMAGE_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_INPUT_IMAGE_BYTES = 768 * 1024;
export const MAX_INPUT_IMAGE_DIMENSION = 1024;
export const MAX_INPUT_IMAGES_PER_MESSAGE = 4;
const MAX_REQUEST_IMAGE_BYTES = 8 * 1024 * 1024;

/** The normalized, immutable image named in a session's display and model history. */
export interface InputImageReference {
  attachmentId: string;
  name: string;
  mediaType: "image/webp";
  bytes: number;
  width: number;
  height: number;
}

function positiveInteger(value: unknown, max: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
}

export function isInputImageReference(value: unknown): value is InputImageReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.attachmentId === "string" && /^sha256:[a-f0-9]{64}$/u.test(ref.attachmentId) &&
    ref.mediaType === "image/webp" && typeof ref.name === "string" && ref.name.length > 0 && ref.name.length <= 180 &&
    positiveInteger(ref.bytes, MAX_INPUT_IMAGE_BYTES) &&
    positiveInteger(ref.width, MAX_INPUT_IMAGE_DIMENSION) && positiveInteger(ref.height, MAX_INPUT_IMAGE_DIMENSION);
}

export function sameInputImage(left: InputImageReference, right: InputImageReference): boolean {
  return left.attachmentId === right.attachmentId && left.name === right.name && left.bytes === right.bytes &&
    left.width === right.width && left.height === right.height && left.mediaType === right.mediaType;
}

export function inputImageReferences(item: Readonly<Record<string, unknown>>): InputImageReference[] {
  if (item.role !== "user" || !Array.isArray(item.content)) return [];
  return item.content.flatMap(part => part?.type === "everpeace_input_image" && isInputImageReference(part.attachment) ? [part.attachment] : []);
}

export type ReadInputImage = (ref: InputImageReference, signal?: AbortSignal) => Promise<Uint8Array>;

/** Resolve image bytes from the current session at the request boundary, newest first within the byte budget. */
export async function projectInputImages(
  input: Array<Record<string, unknown>>,
  read?: ReadInputImage,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  let remaining = MAX_REQUEST_IMAGE_BYTES;
  const urls = new Map<string, string>();
  const output = [...input];
  for (let index = output.length - 1; index >= 0; index--) {
    signal?.throwIfAborted();
    const item = output[index]!;
    if (item.role !== "user" || !Array.isArray(item.content) || !item.content.some(part => part?.type === "everpeace_input_image")) continue;
    const content: unknown[] = [];
    for (const part of item.content) {
      if (part?.type !== "everpeace_input_image") { content.push(part); continue; }
      const ref: unknown = part.attachment;
      if (!isInputImageReference(ref)) throw new Error("Session image reference is invalid");
      if (!read || ref.bytes > remaining) {
        const reason = read ? "this request's image limit" : "the selected model's input capabilities";
        content.push({ type: "input_text", text: `[Earlier image ${JSON.stringify(ref.name)} is unavailable due to ${reason}.]` });
        continue;
      }
      let url = urls.get(ref.attachmentId);
      if (!url) {
        const bytes = await read(ref, signal);
        url = `data:${ref.mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
        urls.set(ref.attachmentId, url);
      }
      remaining -= ref.bytes;
      content.push({ type: "input_image", image_url: url, detail: "auto" });
    }
    output[index] = { ...item, content };
  }
  return output;
}
