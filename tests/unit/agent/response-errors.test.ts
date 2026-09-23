import assert from "node:assert/strict";
import { test } from "node:test";
import { isContextLimitError, isStreamUnsupportedError } from "../../../src/agent/response-errors.js";

test("response error classifiers only accept explicit context and stream capability failures", () => {
  assert.equal(
    isContextLimitError(Object.assign(new Error("maximum context length is 100"), { status: 400 })),
    true,
  );
  assert.equal(
    isContextLimitError(Object.assign(new Error("invalid request"), { status: 400 })),
    false,
  );
  assert.equal(
    isStreamUnsupportedError(Object.assign(new Error("stream is not supported"), {
      status: 400,
      code: "unsupported_parameter",
      param: "stream",
    })),
    true,
  );
  assert.equal(
    isStreamUnsupportedError(Object.assign(new Error("invalid parameter: stream"), {
      status: 400,
      param: "stream",
    })),
    true,
  );
  assert.equal(
    isStreamUnsupportedError(Object.assign(new Error("connection failed"), { status: 503 })),
    false,
  );
});
