import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";
import { render as renderInk } from "ink-testing-library";
import { Prompt } from "../../../src/tui/composer/prompt.js";
import { createComposerState } from "../../../src/tui/composer/editor.js";

const views = new Set<ReturnType<typeof renderInk>>();
function render(tree: Parameters<typeof renderInk>[0]): ReturnType<typeof renderInk> {
  const view = renderInk(tree);
  views.add(view);
  return view;
}
afterEach(() => {
  for (const view of views) {
    view.cleanup();
    view.frames.length = 0;
    view.stderr.frames.length = 0;
  }
  views.clear();
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
test("approval keys have one owner and guidance letters and Enter cannot approve", async () => {
  const editorRef = { current: createComposerState() };
  const decisions: boolean[] = [];
  const guidance: string[] = [];
  const view = render(<Prompt activeModelName="test" editorRef={editorRef}
    onApprovalChoice={(approved) => decisions.push(approved)}
    onSubmit={(value) => { guidance.push(value); return true; }} />);
  await tick();
  view.stdin.write("y");
  await tick();
  assert.deepEqual(decisions, [true]);
  assert.equal(editorRef.current.value, "");
  view.stdin.write("o");
  await tick();
  view.stdin.write("n");
  await tick();
  view.stdin.write("y");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(guidance, ["ony"]);
  assert.deepEqual(decisions, [true]);
  assert.equal(editorRef.current.value, "");
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(decisions, [true, false]);
  assert.deepEqual(guidance, ["ony"]);
});
async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await tick();
  }
  assert.fail("Timed out waiting for submission update");
}
function deferred() {
  let resolve!: (accepted: boolean) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<boolean>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function waitForInput(view: ReturnType<typeof render>, active: boolean): Promise<void> {
  // A rendered draft can precede Ink's passive input effects. Observe the
  // stream subscription before sending one-shot input or settling a pending call.
  await waitFor(() => (view.stdin.listenerCount("readable") > 0) === active);
}

test("pending submission blocks repeated Enter, typing and paste through resize, then clears once", async () => {
  const pending = deferred();
  const editorRef = { current: createComposerState("中文 draft 🙂") };
  const original = editorRef.current;
  const submissions: string[] = [];
  const view = render(<Prompt activeModelName="test" editorRef={editorRef} onSubmit={(value) => {
    submissions.push(value);
    return submissions.length === 1 ? pending.promise : true;
  }} />);
  await waitForInput(view, true);
  view.stdin.write("\r");
  view.stdin.write("\r");
  view.stdin.write("unexpected");
  view.stdin.write("\u001b[200~paste\ntext\u001b[201~");
  Object.defineProperty(view.stdout, "columns", { configurable: true, value: 40 });
  view.stdout.emit("resize");
  await tick();
  assert.deepEqual(submissions, [original.value]);
  assert.strictEqual(editorRef.current, original);
  assert.equal((view.lastFrame() ?? "").split("\n").filter((line) => line.trimStart().startsWith("›")).length, 1);
  await waitForInput(view, false);
  pending.resolve(true);
  await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace"));
  assert.equal(editorRef.current.value, "");
  await waitForInput(view, true);
  view.stdin.write("next draft");
  await waitFor(() => editorRef.current.value === "next draft");
  view.stdin.write("\r");
  await waitFor(() => submissions.length === 2 && editorRef.current.value === "");
  assert.deepEqual(submissions, [original.value, "next draft"]);
});

test("accepted late submission cannot clear the replacement prompt or its history navigation", async () => {
  const pending = deferred();
  const editorRef = { current: createComposerState("old request") };
  const historyNavigationRef: React.RefObject<{ index: number | undefined; draft: string }> = {
    current: { index: undefined, draft: "old draft" },
  };
  const view = render(<Prompt key="old" activeModelName="test" editorRef={editorRef}
    historyNavigationRef={historyNavigationRef} onSubmit={() => pending.promise} />);
  await tick();
  view.stdin.write("\r");
  await tick();
  const replacement = { ...createComposerState("新草稿 🙂"), cursor: 2, killBuffer: "keep", preferredColumn: 2 };
  const navigation = { index: 0, draft: "saved new draft" };
  editorRef.current = replacement;
  historyNavigationRef.current = navigation;
  view.rerender(<Prompt key="new" activeModelName="test" editorRef={editorRef}
    historyNavigationRef={historyNavigationRef} onSubmit={() => false} />);
  await waitFor(() => (view.lastFrame() ?? "").includes("新草稿"));
  pending.resolve(true);
  await pending.promise;
  await tick();
  assert.strictEqual(editorRef.current, replacement);
  assert.strictEqual(historyNavigationRef.current, navigation);
  assert.match(view.lastFrame() ?? "", /新草稿/u);
  assert.equal((view.lastFrame() ?? "").split("\n").filter((line) => line.trimStart().startsWith("›")).length, 1);
  view.stdin.write("X");
  await waitFor(() => editorRef.current.value === "新草X稿 🙂");
});

test("a prompt that left chat ignores acceptance even when its shared draft is unchanged", async () => {
  const pending = deferred();
  const editorRef = { current: createComposerState("unchanged draft") };
  const original = editorRef.current;
  const view = render(<Prompt activeModelName="test" editorRef={editorRef} onSubmit={() => pending.promise} />);
  await tick();
  view.stdin.write("\r");
  await tick();
  view.rerender(<React.Fragment />);
  await tick();
  pending.resolve(true);
  await pending.promise;
  await tick();
  assert.strictEqual(editorRef.current, original);
  view.rerender(<Prompt activeModelName="test" editorRef={editorRef} onSubmit={() => false} />);
  await waitFor(() => (view.lastFrame() ?? "").includes("unchanged draft"));
});

test("submission acceptance only clears the captured composer snapshot", async () => {
  const editorRef = { current: createComposerState("submitted request") };
  const replacement = createComposerState("host restored guidance");
  const view = render(<Prompt activeModelName="test" editorRef={editorRef} onSubmit={() => {
    editorRef.current = replacement;
    return true;
  }} />);
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.strictEqual(editorRef.current, replacement);
});

test("reentrant input cannot start a second submission before the first callback returns", async () => {
  const pending = deferred();
  let calls = 0;
  const view = render(<Prompt activeModelName="test" onSubmit={() => {
    calls++;
    if (calls === 1) view.stdin.write("\r");
    return pending.promise;
  }} />);
  await tick();
  view.stdin.write("request");
  await waitFor(() => (view.lastFrame() ?? "").includes("request"));
  view.stdin.write("\r");
  await tick();
  pending.resolve(false);
  await pending.promise;
  await tick();
  assert.equal(calls, 1);
});

test("false, rejected and thrown submissions preserve the draft and allow an explicit retry", async (context) => {
  for (const outcome of ["false", "reject", "throw"] as const) await context.test(outcome, async () => {
    const pending = deferred();
    const editorRef = { current: createComposerState("keep 中文\n🙂") };
    const original = editorRef.current;
    const submissions: string[] = [];
    const view = render(<Prompt activeModelName="test" editorRef={editorRef} onSubmit={(value) => {
      submissions.push(value);
      if (submissions.length > 1) return true;
      if (outcome === "throw") throw new Error("submission failed");
      return pending.promise;
    }} />);
    await waitForInput(view, true);
    view.stdin.write("\r");
    await waitFor(() => submissions.length === 1);
    if (outcome !== "throw") await waitForInput(view, false);
    if (outcome === "false") pending.resolve(false);
    if (outcome === "reject") pending.reject(new Error("submission failed"));
    if (outcome !== "throw") await pending.promise.catch(() => undefined);
    await waitForInput(view, true);
    assert.strictEqual(editorRef.current, original);
    view.stdin.write("\r");
    await waitFor(() => submissions.length === 2 && editorRef.current.value === "");
    assert.deepEqual(submissions, [original.value, original.value]);
  });
});
