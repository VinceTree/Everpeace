import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import { MarkdownText, RichOutput } from "../../../src/tui/components/rich-text.js";
import { History } from "../../../src/tui/components/history.js";
import { translateLegacyUiText } from "../../../src/tui/legacy-translation.js";

test("Markdown renders headings, lists, links, tables, and highlighted fences", () => {
  const view = render(<MarkdownText text={"# Heading\n\n- **bold** item\n- [x] complete\n\n[docs](https://example.com)\n\n| Key | Value |\n| --- | --- |\n| a | b |\n\n```ts\nconst value = 1;\n```"} />);
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /# Heading/);
  assert.match(frame, /• bold item/);
  assert.match(frame, /\[x\] complete/);
  assert.match(frame, /docs \(https:\/\/example\.com\)/);
  assert.match(frame, /Key/);
  assert.match(frame, /1 │ const value = 1;/);
  view.unmount();
});

test("recognized diff output renders line gutters while ordinary +/- text stays plain", () => {
  const diff = render(<RichOutput text={"--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new"} />);
  assert.match(diff.lastFrame() ?? "", /1\s+│ - old/);
  assert.match(diff.lastFrame() ?? "", /1\s+│ \+ new/);
  diff.unmount();

  const plain = render(<RichOutput text={"- stopped\n+ started"} />);
  assert.match(plain.lastFrame() ?? "", /- stopped/);
  plain.unmount();
});

test("legacy UI messages translate only at display time", () => {
  const source = "搜索网页：TypeScript";
  assert.equal(translateLegacyUiText(source), "Searching the web: TypeScript");
  assert.equal(source, "搜索网页：TypeScript");
  assert.equal(translateLegacyUiText("用户自己的中文"), "用户自己的中文");
});

test("history translates legacy chrome without translating user or assistant content", () => {
  const entries = [
    { id: 1, kind: "user" as const, text: "用户自己的中文" },
    { id: 2, kind: "assistant" as const, text: "模型自己的中文" },
    { id: 3, kind: "tool" as const, text: "搜索网页：测试" },
  ];
  const view = render(<History entries={entries} version="test" workspacePath="C:\\workspace" />);
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /用户自己的中文/);
  assert.match(frame, /模型自己的中文/);
  assert.match(frame, /Searching the web: 测试/);
  assert.equal(entries[2]?.text, "搜索网页：测试");
  view.unmount();
});
