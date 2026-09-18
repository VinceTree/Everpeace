import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import { PermissionsPicker } from "../../../src/tui/components/permissions-picker.js";
import type { PermissionPolicy } from "../../../src/permissions/policy.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test("full access requires a second explicit confirmation and Escape cancels it", async () => {
  const changes: PermissionPolicy[] = [];
  const view = render(<PermissionsPicker policy={{ mode: "ask", web: true }} workspace="/workspace" onChange={(policy) => changes.push(policy)} onBack={() => {}} />);
  await tick();
  view.stdin.write("\u001B[B");
  await tick();
  view.stdin.write("\u001B[B");
  await tick();
  view.stdin.write("\u001B[B");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame() ?? "", /without approval/);
  assert.equal(changes.length, 0);
  view.stdin.write("\u001B");
  await tick();
  assert.equal(changes.length, 0);
  assert.match(view.lastFrame() ?? "", /Read only/);
  view.unmount();
});
