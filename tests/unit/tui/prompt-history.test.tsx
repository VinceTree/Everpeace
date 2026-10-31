import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { Prompt } from "../../../src/tui/composer/prompt.js";
import { textWidth } from "../../../src/tui/rendering/text-width.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test("standalone composer follows resize without losing its draft or accepting terminal replies", async () => {
  const submissions: string[] = [];
  const draft = `keep-${"0123456789".repeat(8)}中文`;
  const view = render(<Prompt activeModelName="test" onSubmit={(text) => { submissions.push(text); }} />);
  try {
    await tick();
    view.stdin.write(draft);
    await tick();
    for (const columns of [40, 100, 52]) {
      Object.defineProperty(view.stdout, "columns", { configurable: true, value: columns });
      view.stdout.emit("resize");
      await tick();
      const frame = view.lastFrame() ?? "";
      assert.match(frame, /中文/u);
      assert.equal(frame.match(/›/gu)?.length, 1);
      assert.ok(frame.split("\n").every((line) => textWidth(line) <= columns));
      assert.deepEqual(submissions, []);
    }
    for (const reply of ["\u001b[I", "\u001b[O", "\u001b[<64;5;5M", "\u001b[12;40R"]) {
      view.stdin.write(reply);
      await tick();
    }
    assert.deepEqual(submissions, []);
    view.stdin.write("\r");
    await waitFor(() => submissions.length === 1);
    assert.deepEqual(submissions, [draft]);
  } finally { view.unmount(); }
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await tick();
  }
  assert.fail("Timed out waiting for prompt update");
}

test("recalled slash commands do not capture history arrows and Down returns to empty", async () => {
  const view = render(<Prompt activeModelName="test" history={["old question", "/resume"]} onSubmit={() => {}} />);
  try {
    await tick();
    view.stdin.write("\u001b[A"); await tick();
    assert.match(view.lastFrame() ?? "", /\/resume/);
    view.stdin.write("\u001b[A"); await tick();
    assert.match(view.lastFrame() ?? "", /old question/);
    view.stdin.write("\u001b[B"); await tick();
    view.stdin.write("\u001b[B"); await tick();
    assert.match(view.lastFrame() ?? "", /Ask Everpeace/);
  } finally { view.unmount(); }
});

test("history navigation restores drafts and Ctrl+C clears before exiting", async () => {
  let exits = 0;
  const submissions: string[] = [];
  const view = render(<Prompt activeModelName="test" history={["first", "!pwd"]} onSubmit={(text) => { submissions.push(text); }} onEmptyInterrupt={() => exits++} />);
  await tick();
  view.stdin.write("draft"); await tick();
  view.stdin.write("\u001b[A"); await tick();
  assert.match(view.lastFrame() ?? "", /!pwd/);
  view.stdin.write("\u001b[B"); await tick();
  assert.match(view.lastFrame() ?? "", /draft/);
  view.stdin.write("\u0003"); await tick();
  assert.equal(exits, 0);
  view.stdin.write("\u0003"); await tick();
  assert.equal(exits, 1);
  assert.deepEqual(submissions, []);
  view.unmount();
});

test("bracketed multiline paste and modified Enter never submit accidentally", async () => {
  const submissions: string[] = [];
  const view = render(<Prompt activeModelName="test" onSubmit={(text) => { submissions.push(text); }} />);
  await tick();
  view.stdin.write("\u001b[200~first\nsecond\u001b[201~"); await tick();
  view.stdin.write("\u001b[13;2u"); await tick();
  view.stdin.write("third"); await tick();
  assert.equal(submissions.length, 0);
  view.stdin.write("\r"); await tick();
  assert.deepEqual(submissions, ["first\nsecond\nthird"]);
  view.unmount();
});

test("file completion inserts an explicit quoted reference and reports one-shot attachments", async () => {
  const submissions: string[] = [];
  const view = render(<Prompt
    activeModelName="test"
    getFileSuggestions={async (query) => query === "src" ? ["src/空 file.ts", "src/other.ts"] : []}
    onSubmit={(text) => { submissions.push(text); }}
  />);
  try {
    await tick();
    view.stdin.write("@src");
    await waitFor(() => (view.lastFrame() ?? "").includes("src/空 file.ts"));
    assert.match(view.lastFrame() ?? "", /src\/空 file\.ts/u);
    view.stdin.write("\r");
    await tick();
    assert.deepEqual(submissions, []);
    assert.match(view.lastFrame() ?? "", /Attached once: src\/空 file\.ts/u);
    view.stdin.write("\r");
    await tick();
    assert.deepEqual(submissions, ['@"src/空 file.ts"']);
  } finally {
    view.unmount();
  }
});

test("a rejected asynchronous submission preserves the composer draft", async () => {
  const view = render(<Prompt activeModelName="test" onSubmit={async () => false} />);
  try {
    await tick();
    view.stdin.write('keep @"missing.txt"');
    await tick();
    view.stdin.write("\r");
    await tick();
    assert.match(view.lastFrame() ?? "", /keep @"missing\.txt"/u);
  } finally {
    view.unmount();
  }
});
