import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import {
  Banner,
  createSessionCard,
} from "../../../src/tui/components/banner.js";
import { textWidth } from "../../../src/tui/text-width.js";

test("Banner renders Codex-style startup model and directory details", () => {
  const view = render(
    <Banner
      version="0.1.19"
      modelName="deepseek-flash"
      workspacePath={"C:\\workspace"}
    />,
  );

  const frame = view.lastFrame() ?? "";
  assert.match(frame, /Everpeace Agent/);
  assert.match(frame, /v0\.1\.19/);
  assert.match(frame, /Peace through order/);
  assert.match(frame, /model:\s+deepseek-flash\s+\/model to change/);
  assert.match(frame, /directory: C:\\workspace/);
  assert.doesNotMatch(frame, /工作空间|当前模型|登录状态|SQLite|MEMORY/);
  const panelBorder = frame.split("\n").find((line) => line.startsWith("╭"));
  assert.equal(panelBorder?.length, 60);
  view.unmount();
});

test("session card keeps fixed rows and never reaches the terminal wrap cell", () => {
  for (const columns of [120, 60, 45, 18, 8]) {
    const card = createSessionCard(
      columns,
      "deepseek-chat-with-a-name-that-needs-truncation",
      "C:\\Users\\39850\\Desktop\\coding-agent\\Everpeace\\a-very-long-directory",
    );

    assert.ok(card);
    const lines = [card.top, card.model, card.directory, card.bottom];
    assert.equal(lines.length, 4);
    assert.ok(card.width <= columns - 1);
    for (const line of lines) assert.equal(textWidth(line), card.width);
  }

  assert.equal(createSessionCard(4, "model", "C:\\workspace"), undefined);
});
