import assert from "node:assert/strict";
import { test } from "node:test";
import { isContextLimitError, isStreamUnsupportedError, ModelStreamCleanupError } from "../../../src/agent/response-errors.js";
import { classifySamplingError } from "../../../src/agent/agent-loop.js";

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

test("a resource cleanup fault cannot be retried through its connection or timeout cause", () => {
  for (const message of ["connection refused", "network timeout", "rate limit", "context window exceeded"]) {
    const cause = Object.assign(new Error(message), { status: 400, code: "context_length_exceeded" });
    const failure = new ModelStreamCleanupError(cause);
    assert.equal(classifySamplingError(failure), "permanent");
    assert.equal(failure.cause, cause);
    assert.equal(failure.usage, null);
  }
});
