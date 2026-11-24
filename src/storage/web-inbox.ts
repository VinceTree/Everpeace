import { MAX_FILE_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES, type PromptAttachment } from "../agent/file-attachments.js";
import { isInputImageReference, MAX_INPUT_IMAGES_PER_MESSAGE, sameInputImage } from "../agent/input-images.js";
import type { TimelineInputFile } from "./session-store.js";

export interface WebInboxItem {
  id: string;
  requestId: string;
  revision: number;
  text: string;
  attachments?: readonly PromptAttachment[];
  uploadedFiles?: readonly TimelineInputFile[];
  referenceContext?: string;
}

export type WebInboxChange =
  | { kind: "put"; item: WebInboxItem }
  | { kind: "remove"; id: string };

export interface WebInbox {
  pending: WebInboxItem[];
  accepted: string[];
}

export const MAX_WEB_INBOX_ITEMS = 16;
export const MAX_WEB_INPUT_TEXT = 64_000;

export function applyWebInboxChange(inbox: WebInbox, change: WebInboxChange): void {
  if (change.kind === "remove") {
    inbox.pending = inbox.pending.filter(item => item.id !== change.id);
    return;
  }
  const item = change.item;
  const index = inbox.pending.findIndex(pending => pending.id === item.id);
  if (index >= 0) {
    inbox.pending[index] = item;
    return;
  }
  inbox.pending.push(item);
  if (!inbox.accepted.includes(item.requestId)) {
    inbox.accepted.push(item.requestId);
    if (inbox.accepted.length > 256) inbox.accepted.shift();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWebInboxIdentity(value: unknown): value is Record<string, unknown> & Pick<WebInboxItem, "id" | "requestId" | "revision"> {
  return record(value) && typeof value.id === "string" && /^[\w-]{1,128}$/u.test(value.id)
    && typeof value.requestId === "string" && value.requestId.length > 0 && value.requestId.length <= 128
    && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0;
}

export function isWebInboxChange(value: unknown): value is WebInboxChange {
  if (!record(value)) return false;
  if (value.kind === "remove") return typeof value.id === "string" && /^[\w-]{1,128}$/u.test(value.id);
  return value.kind === "put" && isWebInboxItem(value.item);
}

function isWebInboxItem(value: unknown): value is WebInboxItem {
  if (!record(value) || !isWebInboxIdentity(value) || typeof value.text !== "string" || value.text.length > MAX_WEB_INPUT_TEXT
    || (value.referenceContext !== undefined && (typeof value.referenceContext !== "string" || value.referenceContext.length > MAX_WEB_INPUT_TEXT))) return false;
  if (value.attachments === undefined && value.uploadedFiles === undefined) return !!value.text.trim();
  const { attachments, uploadedFiles: files } = value;
  if (!Array.isArray(attachments) || !Array.isArray(files) || attachments.length !== files.length || attachments.length > MAX_FILE_ATTACHMENTS
    || (!value.text.trim() && attachments.length === 0)) return false;
  let bytes = 0;
  let images = 0;
  return files.every((file: unknown, index) => {
    const attachment: unknown = attachments[index];
    if (isInputImageReference(file)) {
      return ++images <= MAX_INPUT_IMAGES_PER_MESSAGE && record(attachment) && attachment.source === "image" &&
        isInputImageReference(attachment.reference) && sameInputImage(file, attachment.reference);
    }
    if (!record(file) || !record(attachment) || typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || typeof file.name !== "string" || file.name.length === 0 || file.name.length > 180
      || file.mediaType !== undefined && (typeof file.mediaType !== "string" || !/^[a-z][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9!#$&^_.+-]{1,126}$/iu.test(file.mediaType))
      || typeof attachment.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(attachment.sha256) || file.attachmentId !== `sha256:${attachment.sha256}`
      || attachment.source !== "upload" && attachment.source !== "binary" || attachment.path !== file.name || typeof attachment.content !== "string" || attachment.truncated !== false
      || ![attachment.startLine, attachment.endLine, attachment.totalLines].every(line => typeof line === "number" && Number.isSafeInteger(line) && line >= 0)) return false;
    bytes += Math.max(file.bytes, Buffer.byteLength(attachment.content, "utf8"));
    return bytes <= MAX_TOTAL_ATTACHMENT_BYTES;
  });
}
