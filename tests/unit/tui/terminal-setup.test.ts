import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "jsonc-parser";
import { prepareTerminalSettings, applyTerminalSettings } from "../../../src/tui/terminal-setup.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

test("terminal setup preserves JSONC comments and rejects conflicting key bindings", () => {
  const after = prepareTerminalSettings('{\n// keep\n"actions": [], "keybindings": [], "copyOnSelect": false,\n}');
  assert.match(after, /keep/);
  const data = parse(after);
  assert.equal(data.actions[0].command.input, "\n");
  assert.equal(data.keybindings[0].keys, "shift+enter");
  assert.equal(data.copyOnSelect, false);
  assert.throws(() => prepareTerminalSettings(after), /already/);
  assert.throws(() => prepareTerminalSettings("bad"), /Invalid/);
});

test("terminal setup refuses stale previews and writes a backup on explicit apply", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-setup-"));
  try {
    const file = path.join(dir, "settings.json");
    await fs.writeFile(file, "{}");
    await assert.rejects(applyTerminalSettings(file, "old", "new"), /changed/);
    const after = prepareTerminalSettings("{}");
    const backup = await applyTerminalSettings(file, "{}", after);
    assert.equal(await fs.readFile(backup, "utf8"), "{}");
    assert.equal(await fs.readFile(file, "utf8"), after);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
