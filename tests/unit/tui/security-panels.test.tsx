import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { ActionConfirmation } from "../../../src/tui/components/screens/action-confirmation.js";
import { WebSurface } from "../../../src/tui/components/screens/web-surface.js";
import { CostSurface } from "../../../src/tui/components/screens/cost-surface.js";
import type { ModelPrice } from "../../../src/status/cost.js";
import { stripVTControlCharacters } from "node:util";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 40));
async function waitFor(view: { lastFrame(): string | undefined }, pattern: RegExp): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!pattern.test(stripVTControlCharacters(view.lastFrame() ?? "")) && Date.now() < deadline) await tick();
  assert.match(stripVTControlCharacters(view.lastFrame() ?? ""), pattern);
  await tick();
}
test("live diagnostic preview defaults to cancel, supports Esc and resize, and starts once only after selection", async () => {
  let starts = 0, cancels = 0;
  const view = render(<ActionConfirmation text="Endpoint fixture; 8 requests; Request token budget 20000" start={() => { starts++; }} cancel={() => { cancels++; }} />);
  try {
    await tick(); Object.defineProperty(view.stdout, "columns", { configurable: true, value: 48 }); view.stdout.emit("resize"); await tick();
    assert.match(view.lastFrame() ?? "", /20000/u); assert.equal(starts, 0);
    view.stdin.write("\r"); await tick(); assert.equal(cancels, 1); assert.equal(starts, 0);
    view.stdin.write("\u001b[B"); await tick(); view.stdin.write("\r"); await tick(); assert.equal(starts, 1);
    view.stdin.write("\u001b"); await tick(); assert.equal(cancels, 2);
  } finally { view.cleanup(); }
});
test("web provider keeps keys masked, saves only after confirmation and cancels without configuring", async () => {
  const configured: unknown[] = []; let back = 0;
  const view = render(<WebSurface configure={async (...args) => { configured.push(args); }} onBack={() => { back++; }} />);
  try {
    await tick(); view.stdin.write("\u001b[B"); await tick(); view.stdin.write("\r"); await waitFor(view, /Brave API key/u);
    view.stdin.write("\r"); await waitFor(view, /A Brave API key is required/u); assert.equal(configured.length, 0);
    view.stdin.write("offline-key-fixture"); await waitFor(view, /\*{19}/u); assert.doesNotMatch(view.lastFrame() ?? "", /offline-key-fixture/u);
    Object.defineProperty(view.stdout, "columns", { configurable: true, value: 55 }); view.stdout.emit("resize"); await waitFor(view, /\*{19}/u);
    view.stdin.write("\r"); await waitFor(view, /Save brave/u); assert.equal(configured.length, 0);
    view.stdin.write("\r"); await tick(); assert.deepEqual(configured, [["brave", "offline-key-fixture"]]); assert.equal(back, 1);
  } finally { view.cleanup(); }
  const cancel = render(<WebSurface configure={async () => { assert.fail("Cancel cannot configure"); }} onBack={() => { back++; }} />);
  try { await tick(); cancel.stdin.write("\u001b"); await tick(); assert.equal(back, 2); } finally { cancel.cleanup(); }
});
test("cost prices require a confirmed snapshot and keep estimates distinct from request budgets", async () => {
  const configured: ModelPrice[] = []; let back = 0;
  const view = render(<CostSurface modelId="fixture" status={async () => "unknown / partial"} configure={async (_id, price) => { configured.push(price); }} onBack={() => { back++; }} />);
  try {
    await tick(); assert.match(view.lastFrame() ?? "", /not a hard spending limit/u);
    view.stdin.write("\u001b[B"); await tick(); view.stdin.write("\r"); await tick();
    const prompts = [/Currency \(three letters/u, /Input price per million/u, /Cached input price/u, /Output price per million/u, /Task warning threshold/u];
    for (const [index, value] of ["USD", "2", "1", "4", "10"].entries()) { await waitFor(view, prompts[index]!); view.stdin.write(value); await waitFor(view, new RegExp(`\n\\s*${value}(?:\\s|$)`, "u")); view.stdin.write("\r"); }
    await waitFor(view, /Save prices and task warning/u);
    assert.equal(configured.length, 0);
    Object.defineProperty(view.stdout, "columns", { configurable: true, value: 50 }); view.stdout.emit("resize"); await tick();
    view.stdin.write("\u001b[B"); await tick(); view.stdin.write("\r"); await tick();
    assert.deepEqual(configured, [{ currency: "USD", input: 2, cachedInput: 1, output: 4, warningThreshold: 10 }]); assert.equal(back, 1);
  } finally { view.cleanup(); }
});
