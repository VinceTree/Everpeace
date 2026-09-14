import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../../../src/cli/args.js";

test("parseArgs starts the agent by default", () => {
  assert.deepEqual(parseArgs([]), { command: "run", help: false });
});

test("parseArgs accepts authentication management commands", () => {
  assert.equal(parseArgs(["login"]).command, "login");
  assert.equal(parseArgs(["models"]).command, "models");
  assert.equal(parseArgs(["logout"]).command, "logout");
});

test("parseArgs recognizes help and rejects unsupported arguments", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["--model", "anything"]), /Unknown argument/);
  assert.throws(() => parseArgs(["login", "models"]), /Unknown argument/);
});
