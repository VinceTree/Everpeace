import { createHash } from "node:crypto";
import { MAX_INPUT_IMAGE_BYTES, MAX_INPUT_IMAGE_DIMENSION, type InputImageReference } from "../agent/input-images.js";

const mediaFormats = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;

export function acceptedImageFormat(mediaType: string): string | undefined {
  return Object.hasOwn(mediaFormats, mediaType) ? mediaFormats[mediaType as keyof typeof mediaFormats] : undefined;
}

/** Decode the first frame, bound pixel work and strip metadata from stored browser images. */
export async function normalizeImage(bytes: Uint8Array, format: string, name: string): Promise<{ reference: InputImageReference; bytes: Buffer }> {
  const expected = Buffer.from(bytes);
  // Admit raster input only. Reject documents and XML before passing data to a decoder.
  const signature = format === "png" ? expected.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
    : format === "jpeg" ? expected[0] === 0xff && expected[1] === 0xd8
      : format === "gif" ? /^(?:GIF87a|GIF89a)$/u.test(expected.subarray(0, 6).toString("ascii"))
        : expected.toString("ascii", 0, 4) === "RIFF" && expected.toString("ascii", 8, 12) === "WEBP";
  if (!signature) throw new Error("Image format does not match the upload");
  const { default: sharp } = await import("sharp");
  const image = sharp(expected, { failOn: "error", limitInputPixels: 24_000_000, pages: 1 });
  const metadata = await image.metadata();
  if (metadata.format !== format) throw new Error("Image format does not match the upload");
  const normalized = await image.autoOrient().resize({
    width: MAX_INPUT_IMAGE_DIMENSION, height: MAX_INPUT_IMAGE_DIMENSION, fit: "inside", withoutEnlargement: true,
  }).webp({ quality: 90 }).timeout({ seconds: 6 }).toBuffer({ resolveWithObject: true });
  const { data, info } = normalized;
  if (data.length > MAX_INPUT_IMAGE_BYTES) throw new Error("Normalized image exceeds the size limit");
  return { bytes: data, reference: {
    attachmentId: `sha256:${createHash("sha256").update(data).digest("hex")}`,
    name, mediaType: "image/webp", bytes: data.length, width: info.width, height: info.height,
  } };
}
