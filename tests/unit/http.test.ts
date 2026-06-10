import { test } from "vitest";
import { strict as assert } from "node:assert";
import { cleanString, normalizeTimeout, readLimitedText, textResponse } from "../../src/shared/http";
import { PayloadTooLargeError } from "../../src/shared/http";

test("normalizes and bounds command timeouts", () => {
  assert.equal(normalizeTimeout("0"), 1);
  assert.equal(normalizeTimeout("12.9"), 12);
  assert.equal(normalizeTimeout("9000"), 50);
  assert.equal(normalizeTimeout("nope"), 30);
});

test("cleans strings without coercing non-strings", () => {
  assert.equal(cleanString("abcdef", 3), "abc");
  assert.equal(cleanString(123, 3), "");
});

test("reads limited text and rejects oversized bodies", async () => {
  assert.equal(await readLimitedText(new Request("https://soe.test", { method: "POST", body: "hello" }), 5), "hello");
  await assert.rejects(
    readLimitedText(new Request("https://soe.test", { method: "POST", body: "hello!" }), 5),
    PayloadTooLargeError
  );
});

test("text responses always set no-store and content type", () => {
  const text = textResponse("ok", 202, "text/x-test");
  assert.equal(text.status, 202);
  assert.equal(text.headers.get("Cache-Control"), "no-store");
  assert.equal(text.headers.get("Content-Type"), "text/x-test");
});
