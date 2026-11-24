import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebEvent, WebState } from "../../../src/web/protocol.js";
import { startWebFixture } from "../../fixtures/web-workbench.js";

test("authenticated browser turns resume in place, preserve approvals on reconnect, and stop safely", { timeout: 45_000 }, async (t) => {
  const fixture = await startWebFixture();
  t.after(() => fixture.close());
  const url = new URL(fixture.url);
  const auth = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const route = (pathname: string) => new URL(pathname, url.origin);
  const command = (pathname: string, data: object, origin = url.origin) => fetch(route(`/api/${pathname}`), {
    method: "POST", headers: { ...auth, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  assert.equal((await fetch(route("/api/events"))).status, 401);
  assert.equal((await command("session", { sessionId: null }, "https://other.invalid")).status, 403);
  assert.equal((await command("session", { sessionId: fixture.foreign.id })).status, 404);
  assert.equal((await fetch(route("/"))).status, 200);
  assert.equal((await fetch(route("/workbench.js"))).status, 200);
  assert.equal((await fetch(route("/workbench.css"))).status, 200);

  async function subscribe() {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(40_000)]);
    const response = await fetch(route("/api/events"), { headers: auth, signal });
    assert.equal(response.status, 200);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let state: WebState | undefined;
    return {
      close() { controller.abort(); },
      async until(matches: (state: WebState) => boolean): Promise<WebState> {
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary === -1) {
            const { done, value } = await reader.read().catch((cause: unknown) => {
              throw new Error(`Workbench stream stalled. Last state: ${JSON.stringify(state)}`, { cause });
            });
            if (done) throw new Error("Workbench stream closed");
            buffer += value;
            continue;
          }
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (!frame.startsWith("data: ")) continue;
          const event = JSON.parse(frame.slice(6)) as WebEvent;
          if ("state" in event) state = event.state;
          else if (state) state.turn = event.turn;
          if (state && matches(state)) return state;
        }
      },
    };
  }

  const primary = await subscribe();
  t.after(() => primary.close());
  assert.deepEqual((await primary.until(() => true)).sessions.map(session => session.id), [fixture.terminal.id]);
  assert.equal((await command("session", { sessionId: fixture.terminal.id })).status, 200);
  const resumed = await primary.until(state => state.sessionId === fixture.terminal.id);
  assert.match(resumed.timeline[0]!.text, /Saved before opening/u);
  assert.equal((await command("model", { modelId: "offline-pro", sessionId: fixture.terminal.id })).status, 200);
  const send = (prompt: string) => command("send", { prompt, sessionId: fixture.terminal.id, modelId: "offline-pro" });

  assert.equal((await send("Run the offline tool")).status, 200);
  const pending = (await primary.until(state => state.turn?.interaction?.kind === "approval")).turn!;
  assert.equal(fixture.commands.length, 0);
  assert.equal((await send("overlapping prompt")).status, 409);
  const reconnect = await subscribe();
  const restored = (await reconnect.until(() => true)).turn!;
  assert.equal(restored.interaction?.id, pending.interaction?.id);
  reconnect.close();
  const approve = (turnId: string, requestId: string, answer: unknown) => command("answer", { turnId, requestId, answer });
  async function waitForApproval() {
    const state = await primary.until(state => Boolean(state.turn?.interaction));
    const turn = state.turn!;
    if (turn.interaction?.kind === "question" && turn.interaction.questions[0]?.id === "sensitive_access") {
      assert.equal((await approve(turn.id, turn.interaction.id, { sensitive_access: "Mask content" })).status, 200);
      return (await primary.until(state => state.turn?.interaction?.kind === "approval")).turn!;
    }
    assert.equal(turn.interaction?.kind, "approval");
    return turn;
  }
  assert.equal((await approve(restored.id, restored.interaction!.id, true)).status, 200);
  assert.equal((await approve(restored.id, restored.interaction!.id, true)).status, 409);
  await primary.until(state => Boolean(state.turn?.delta.includes("Offline reply")));
  await primary.until(state => state.turn === null);
  assert.deepEqual(fixture.commands, ["echo offline"]);
  assert.equal(fixture.requests(), 2);
  let disk = await fixture.store.load(fixture.terminal.id);
  assert.equal(disk.summary.model.id, "offline-pro");
  assert.ok(disk.timeline.some(entry => entry.kind === "tool" && entry.text.includes("offline tool output")));
  assert.equal((await fixture.store.list()).sessions.length, 2);

  assert.equal((await send("Ask a question")).status, 200);
  const question = (await primary.until(state => state.turn?.interaction?.kind === "question")).turn!;
  assert.equal((await approve(question.id, question.interaction!.id, {})).status, 400);
  assert.equal((await approve(question.id, question.interaction!.id, { scope: "Small" })).status, 200);
  await primary.until(state => state.turn === null);
  disk = await fixture.store.load(fixture.terminal.id);
  assert.match(JSON.stringify(disk.context), /Small/u);

  assert.equal((await send("Run the offline tool and decline")).status, 200);
  const declined = await waitForApproval();
  assert.equal((await approve(declined.id, declined.interaction!.id, false)).status, 200);
  await primary.until(state => state.turn === null);
  assert.equal(fixture.commands.length, 1);

  assert.equal((await send("Run the offline tool and stop")).status, 200);
  const stopped = await waitForApproval();
  assert.equal((await command("stop", { turnId: stopped.id })).status, 200);
  assert.equal((await approve(stopped.id, stopped.interaction!.id, true)).status, 409);
  assert.equal((await primary.until(state => state.turn === null)).error, "cancelled");

  assert.equal((await send("Run the offline tool after a policy change")).status, 200);
  const changed = await waitForApproval();
  fixture.tighten();
  assert.equal((await approve(changed.id, changed.interaction!.id, true)).status, 200);
  assert.match((await primary.until(state => state.turn === null)).error ?? "", /policy changed/u);
  assert.equal(fixture.commands.length, 1);
});
