import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import {
  CommandScreen,
  CommandSurface,
  commandScreenWidth,
} from "../../../src/tui/components/command-surface.js";
import { textWidth } from "../../../src/tui/text-width.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("command screen width is capped and preserves narrow-terminal margins", () => {
  assert.equal(commandScreenWidth(120), 80);
  assert.equal(commandScreenWidth(82), 80);
  assert.equal(commandScreenWidth(64), 62);
  assert.equal(commandScreenWidth(2), 1);
});

test("command screen centers its bounded surface horizontally and vertically", async () => {
  const view = render(
    <CommandScreen>
      <CommandSurface title="Centered" onBack={() => undefined}>
        <Text>content</Text>
      </CommandSurface>
    </CommandScreen>,
  );
  await tick();

  let lines = (view.lastFrame() ?? "").split("\n");
  let topIndex = lines.findIndex((line) => line.trimStart().startsWith("╭"));
  let bottomIndex = lines.findIndex((line) => line.trimStart().startsWith("╰"));
  assert.ok(topIndex > 0);
  assert.ok(bottomIndex >= topIndex);
  assert.ok(lines.slice(bottomIndex + 1).some((line) => line.length === 0));
  let topBorder = lines[topIndex] ?? "";
  assert.equal(textWidth(topBorder.trimStart()), 80);
  assert.equal(textWidth(topBorder) - textWidth(topBorder.trimStart()), 10);

  Object.defineProperty(view.stdout, "columns", {
    configurable: true,
    value: 50,
  });
  Object.defineProperty(view.stdout, "rows", {
    configurable: true,
    value: 18,
  });
  view.stdout.emit("resize");
  await tick();

  lines = (view.lastFrame() ?? "").split("\n");
  topIndex = lines.findIndex((line) => line.trimStart().startsWith("╭"));
  bottomIndex = lines.findIndex((line) => line.trimStart().startsWith("╰"));
  assert.ok(topIndex > 0);
  assert.ok(bottomIndex >= topIndex);
  topBorder = lines[topIndex] ?? "";
  assert.equal(textWidth(topBorder.trimStart()), 48);
  assert.equal(textWidth(topBorder) - textWidth(topBorder.trimStart()), 1);
  assert.ok(lines.every((line) => textWidth(line) <= 49));

  view.unmount();
});
