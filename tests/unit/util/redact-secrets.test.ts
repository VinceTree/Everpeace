import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "../../../src/memory/learned-memory.js";
import { redactSecretsPreservingLayout } from "../../../src/util/redact-secrets.js";

test("credential redaction preserves CRLF, indentation, Unicode, and harmless markup", () => {
  const input = '中文 😀\r\n\t<user>keep</user>\r\n  api_key = "fixture-sensitive-value"\r\n\tBearer\r\n  abcdefghijklmnopqrstuvwxyz\r\nend\r\n';
  assert.equal(
    redactSecretsPreservingLayout(input),
    '中文 😀\r\n\t<user>keep</user>\r\n  api_key = "[secret redacted]"\r\n\tBearer\r\n  [secret redacted]\r\nend\r\n',
  );
});

test("all existing credential patterns share a redactor without implicit truncation", () => {
  const secrets = [
    "sk-abcdefghijklmnopqrstuvwx",
    "sk-proj-abcdefghijklmnopqrstuvwx",
    "ghp_abcdefghijklmnopqrstuvwx",
    "xoxb-abcdefghijklmnopqrstuvwx",
    "AKIA0123456789ABCDEF",
    "Bearer abcdefghijklmnopqrstuvwx",
    '"access_token":"fixture-access-value"',
    "password=fixture-password-value",
    "private-key='fixture-private-value'",
  ];
  const input = `${secrets.join("\n")}\n${"normal text ".repeat(4_000)}`;
  const redacted = redactSecretsPreservingLayout(input);
  for (const secret of secrets) assert.equal(redacted.includes(secret), false);
  assert.equal(redacted.split("\n").length, input.split("\n").length);
  assert.ok(redacted.length > 24 * 1024);
  assert.ok(redacted.endsWith("normal text "));
});

test("PEM redaction preserves every line ending and indentation, including truncated PEM", () => {
  const complete = "before\r\n  -----BEGIN PRIVATE KEY-----\r\n    sensitivekeybytes\r\n\tmorekeybytes\r\n  -----END PRIVATE KEY-----\r\nafter";
  assert.equal(
    redactSecretsPreservingLayout(complete),
    "before\r\n  [private key redacted]\r\n    [private key redacted]\r\n\t[private key redacted]\r\n  [private key redacted]\r\nafter",
  );
  const truncated = `before\n\t-----BEGIN PRIVATE KEY-----\n  ${"Q".repeat(30_000)}\n\tlast-key-fragment`;
  assert.equal(
    redactSecretsPreservingLayout(truncated),
    "before\n\t[private key redacted]\n  [private key redacted]\n\t[private key redacted]",
  );
});

test("redaction before paging removes a credential crossing the original page boundary", () => {
  const pageBytes = 24 * 1024;
  const secret = "sk-proj-abcdefghijklmnopqrstuvwx";
  const input = `${"x".repeat(pageBytes - 12)}\n${secret}\n尾部 😀\r\n`;
  const redacted = Buffer.from(redactSecretsPreservingLayout(input), "utf8");
  const pages = [redacted.subarray(0, pageBytes), redacted.subarray(pageBytes)];
  const recombined = Buffer.concat(pages).toString("utf8");
  assert.doesNotMatch(recombined, /abcdefghijklmnopqrstuvwx/u);
  assert.equal(recombined, redactSecretsPreservingLayout(input));
});

test("redaction retains valid JSON and quoted secret delimiters", () => {
  const input = '{\r\n  "api_key": "fixture-sensitive-value",\r\n  "token": "Bearer abcdefghijklmnopqrstuvwx",\r\n  "message": "中文 😀"\r\n}';
  const redacted = redactSecretsPreservingLayout(input);
  assert.deepEqual(JSON.parse(redacted), { api_key: "[secret redacted]", token: "Bearer [secret redacted]", message: "中文 😀" });
  assert.equal(redacted.split("\r\n").length, input.split("\r\n").length);
  assert.match(redacted, /\r\n  "api_key": "\[secret redacted\]"/u);
  assert.equal(redactSecrets('{"api_key":"fixture-sensitive-value"}'), '{"api_key":[secret redacted]}');
  assert.deepEqual(JSON.parse(redactSecretsPreservingLayout(JSON.stringify({ password: 'sensitive"escaped fragment', private_key: "a\\b" }))), { password: "[secret redacted]", private_key: "[secret redacted]" });
  assert.equal(redactSecretsPreservingLayout('password="first\r\n  second"\r\nafter'), 'password="[secret redacted]\r\n  [secret redacted]"\r\nafter');
});

test("escaped complete and truncated PEM inside JSON are redacted without invalidating JSON", () => {
  for (const key of ["-----BEGIN PRIVATE KEY-----\n  sensitivebytes\n-----END PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----\r\n  sensitivebytes"]) {
    const redacted = redactSecretsPreservingLayout(JSON.stringify({ output: key, after: "kept" }));
    const parsed = JSON.parse(redacted) as { output: string; after: string };
    assert.doesNotMatch(redacted, /sensitivebytes|BEGIN PRIVATE KEY/u);
    assert.equal(parsed.after, "kept");
    assert.deepEqual(parsed.output.match(/\r?\n/gu), key.match(/\r?\n/gu));
  }
});

test("layout redaction is idempotent for retained output and repeated historical reads", () => {
  for (const input of [
    "api_key=sk-abcdefghijklmnopqrstuv\r\nBearer abcdefghijklmnopqrstuvwx",
    'api_key="fixture-sensitive-value"\nsecret=[secret redacted]\nprivate_key=[private key redacted]',
    JSON.stringify({ api_key: "fixture-sensitive-value", output: "Bearer\r\n  abcdefghijklmnopqrstuvwx", key: "-----BEGIN PRIVATE KEY-----\n  secret" }),
  ]) {
    const redacted = redactSecretsPreservingLayout(input);
    assert.equal(redactSecretsPreservingLayout(redacted), redacted);
  }
});

test("learned memory retains its whitespace cleanup and bounded field behavior", () => {
  assert.equal(redactSecrets("  before\n\t<user>secret</user>\n  api_key=value\n  after  "), "before [tag removed]secret[tag removed] api_key=[secret redacted] after");
  assert.equal(redactSecrets("\n  hello  world  \r\n", 8), "hello wo");
  assert.equal(redactSecrets("-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"), "[private key redacted]");
});
