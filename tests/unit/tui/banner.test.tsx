import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import {
  Banner,
  createBrandCard,
  createSessionCard,
} from "../../../src/tui/components/conversation/banner.js";
import { textWidth } from "../../../src/tui/rendering/text-width.js";

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
  assert.match(frame, /天下长平，以规司矩/);
  assert.match(frame, /長安 · 司矩/);
  assert.match(frame, /model:\s+deepseek-flash\s+\/model to change/);
  assert.match(frame, /directory: C:\\workspace/);
  assert.doesNotMatch(frame, /工作空间|当前模型|登录状态|SQLite|MEMORY/);
  const panelBorder = frame.split("\n").find((line) => line.startsWith("╭"));
  assert.equal(panelBorder?.length, 60);
  view.unmount();
});

test("brand title is centered inside its gold frame by terminal cell width", () => {
  const [top, title, bottom] = createBrandCard();
  const label = "長安 · 司矩";
  const content = title.slice(1, -1);
  const labelStart = content.indexOf(label);

  assert.equal(textWidth(top), textWidth(title));
  assert.equal(textWidth(bottom), textWidth(title));
  assert.equal(textWidth(content.slice(0, labelStart)), 3);
  assert.equal(textWidth(content.slice(labelStart + label.length)), 4);
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
