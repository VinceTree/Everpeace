import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNumberSelection } from "../../../src/cli/selection.js";

test("parseNumberSelection parses and deduplicates multiple indexes", () => {
  assert.deepEqual(parseNumberSelection("1, 3,1", 3, true), [0, 2]);
});

test("parseNumberSelection validates indexes and cancellation", () => {
  assert.deepEqual(parseNumberSelection("0", 3, false), []);
  assert.deepEqual(parseNumberSelection("4", 3, false), []);
  assert.deepEqual(parseNumberSelection("1,2", 3, false), []);
  assert.equal(parseNumberSelection("q", 3, true), undefined);
});
