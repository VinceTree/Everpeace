import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  attachmentInputText,
  parseFileReferences,
  resolveFileAttachments,
  userMessageWithAttachments,
} from "../../../src/agent/file-attachments.js";

test("file references parse quoted Unicode paths and ignore Markdown code", () => {
  const input = [
    'Use @"src/空 格.ts"#L10-L40 and keep a@b.example plus @scope/package literal.',
    '`@"inline.ts"`',
    "```ts",
    '@"fenced.ts"',
    "```",
  ].join("\n");
  assert.deepEqual(parseFileReferences(input).map(({ path: filePath, startLine, endLine }) => ({ path: filePath, startLine, endLine })), [
    { path: "src/空 格.ts", startLine: 10, endLine: 40 },
  ]);
});

test("file attachment resolution is bounded, fresh, and represented once beside the prompt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-attachments-"));
  try {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "空 格.ts"), Array.from({ length: 260 }, (_, index) => `line ${index + 1}`).join("\n"));
    const text = 'Review @"src/空 格.ts"#L10-L40 and @"src/空 格.ts"#L10-L40';
    const attachments = await resolveFileAttachments(text, root);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]?.startLine, 10);
    assert.equal(attachments[0]?.endLine, 40);
    assert.equal(attachments[0]?.truncated, true);
    assert.match(attachments[0]?.content ?? "", /^line 10\n/u);
    assert.match(attachments[0]?.content ?? "", /line 40$/u);
    const defaultExcerpt = await resolveFileAttachments('@"src/空 格.ts"', root);
    assert.equal(defaultExcerpt[0]?.startLine, 1);
    assert.equal(defaultExcerpt[0]?.endLine, 200);
    assert.equal(defaultExcerpt[0]?.truncated, true);

    const message = userMessageWithAttachments(text, attachments);
    const serialized = JSON.stringify(message);
    assert.equal(serialized.match(/host_file_attachment/gu)?.length, 2);
    assert.match(attachmentInputText(attachments[0]!), /"start_line":10/u);

    await fs.writeFile(path.join(root, "src", "空 格.ts"), "changed\n", "utf8");
    assert.equal((await resolveFileAttachments('@"src/空 格.ts"', root))[0]?.content, "changed\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("file attachment failures reject malformed, missing, unsafe, oversized, and out-of-range input", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-attachment-limits-"));
  const root = path.join(parent, "workspace");
  try {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "small.txt"), "one\ntwo\n", "utf8");
    await fs.writeFile(path.join(root, "large.txt"), "x".repeat(33 * 1024), "utf8");
    await fs.writeFile(path.join(root, "binary.dat"), Buffer.from([0, 1, 2]));
    for (const name of ["part-a.txt", "part-b.txt", "part-c.txt"]) {
      await fs.writeFile(path.join(root, name), "x".repeat(22 * 1024), "utf8");
    }
    await fs.writeFile(path.join(parent, "outside.txt"), "private", "utf8");
    await assert.rejects(resolveFileAttachments('@"unterminated', root), /Malformed file reference/u);
    await assert.rejects(resolveFileAttachments('@"small.txt"#L2-L1002', root), /1,000-line limit/u);
    await assert.rejects(resolveFileAttachments('@"small.txt"#L20', root), /starts after the end/u);
    await assert.rejects(resolveFileAttachments('@"missing.txt"', root), /does not exist/u);
    await assert.rejects(resolveFileAttachments('@"../outside.txt"', root), /workspace/u);
    await assert.rejects(resolveFileAttachments('@"large.txt"', root), /32 KiB/u);
    await assert.rejects(resolveFileAttachments('@"binary.dat"', root), /Binary/u);
    await assert.rejects(resolveFileAttachments('@"part-a.txt" @"part-b.txt" @"part-c.txt"', root), /64 KiB total/u);
    const tooMany = Array.from({ length: 9 }, (_, index) => `@"small.txt"#L${index + 1}`).join(" ");
    await assert.rejects(resolveFileAttachments(tooMany, root), /at most 8/u);
    const cancelled = new AbortController();
    cancelled.abort(new Error("cancel attachment read"));
    await assert.rejects(resolveFileAttachments('@"small.txt"', root, cancelled.signal), /cancel attachment read/u);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
