import { test } from "node:test";
import { strict as assert } from "node:assert";
import { apiKey, bearerToken, cleanString, jsonResponse, normalizeTimeout, readJson, readLimitedText, textResponse } from "../../.tmp/test-build/src/http.js";
import { PayloadTooLargeError, BadRequestError } from "../../.tmp/test-build/src/http.js";

const validUuid = ["550e8400", "e29b", "41d4", "a716", "446655440000"].join("-");

test("parses bearer tokens and UUID api keys strictly", () => {
  const sampleToken = ["sample", "value"].join("-");
  assert.equal(bearerToken(new Request("https://soe.test", { headers: { Authorization: `Bearer ${sampleToken}` } })), sampleToken);
  assert.equal(bearerToken(new Request("https://soe.test", { headers: { Authorization: `Basic ${sampleToken}` } })), "");
  assert.equal(apiKey(new Request("https://soe.test", { headers: { "x-api-key": validUuid } })), validUuid);
  assert.equal(apiKey(new Request("https://soe.test", { headers: { "x-api-key": "not-a-uuid" } })), "");
});

test("normalizes and bounds command timeouts", () => {
  assert.equal(normalizeTimeout("0"), 1);
  assert.equal(normalizeTimeout("12.9"), 12);
  assert.equal(normalizeTimeout("9000"), 3600);
  assert.equal(normalizeTimeout("nope"), 900);
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

test("reads JSON only for JSON content and reports invalid JSON", async () => {
  assert.deepEqual(await readJson(new Request("https://soe.test", { method: "POST", body: "ignored" })), {});
  assert.deepEqual(await readJson(new Request("https://soe.test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true })
  })), { ok: true });
  await assert.rejects(
    readJson(new Request("https://soe.test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })),
    BadRequestError
  );
});

test("response helpers always set no-store and content type", () => {
  const json = jsonResponse({ ok: true }, 201);
  assert.equal(json.status, 201);
  assert.equal(json.headers.get("Cache-Control"), "no-store");
  assert.match(json.headers.get("Content-Type") || "", /^application\/json/);

  const text = textResponse("ok", 202, "text/x-test");
  assert.equal(text.status, 202);
  assert.equal(text.headers.get("Cache-Control"), "no-store");
  assert.equal(text.headers.get("Content-Type"), "text/x-test");
});
