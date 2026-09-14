import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import { Banner } from "../../../src/tui/components/banner.js";

test("Banner renders Codex-style startup model and directory details", () => {
  const view = render(
    <Banner
      version="0.1.10"
      modelName="deepseek-flash"
      workspacePath={"C:\\workspace"}
    />,
  );

  const frame = view.lastFrame() ?? "";
  assert.match(frame, /Everpeace Agent/);
  assert.match(frame, /v0\.1\.10/);
  assert.match(frame, /长平/);
  assert.match(frame, /model: deepseek-flash\s+\/model to change/);
  assert.match(frame, /directory: C:\\workspace/);
  assert.doesNotMatch(frame, /工作空间|当前模型|登录状态|SQLite|MEMORY/);
  view.unmount();
});
