import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeRequest,
  isValidAccessTokenConfiguration,
  MAX_MESSAGE_CHARS,
  MAX_REQUEST_BYTES,
  readJsonBody,
  RequestBodyError,
  validateMessages,
} from "../lib/chat-validation.mjs";

test("access-token configuration requires a strong, unpadded secret", () => {
  assert.equal(isValidAccessTokenConfiguration("x".repeat(32)), true);
  assert.equal(isValidAccessTokenConfiguration("short"), false);
  assert.equal(isValidAccessTokenConfiguration(` ${"x".repeat(32)}`), false);
});

test("authorizeRequest accepts only an exact bearer token", () => {
  assert.equal(authorizeRequest("Bearer secret-token", "secret-token"), true);
  assert.equal(authorizeRequest("Bearer wrong", "secret-token"), false);
  assert.equal(authorizeRequest("secret-token", "secret-token"), false);
});

test("validateMessages accepts a bounded alternating conversation", () => {
  const result = validateMessages([
    { role: "user", content: "hello", ignored: true },
    { role: "assistant", content: "hi" },
    { role: "user", content: "continue" },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.messages, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "continue" },
  ]);
});

test("validateMessages rejects invalid roles and oversized content", () => {
  assert.equal(
    validateMessages([{ role: "assistant", content: "hello" }]).ok,
    false
  );
  assert.equal(
    validateMessages([
      { role: "user", content: "x".repeat(MAX_MESSAGE_CHARS + 1) },
    ]).ok,
    false
  );
});

test("readJsonBody rejects malformed and oversized payloads", async () => {
  await assert.rejects(
    readJsonBody(
      new Request("https://example.test", {
        method: "POST",
        body: "not json",
      })
    ),
    (error) => error instanceof RequestBodyError && error.status === 400
  );

  await assert.rejects(
    readJsonBody(
      new Request("https://example.test", {
        method: "POST",
        body: "x".repeat(MAX_REQUEST_BYTES + 1),
      })
    ),
    (error) => error instanceof RequestBodyError && error.status === 413
  );
});
