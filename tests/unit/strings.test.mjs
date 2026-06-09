import { test } from "node:test";
import { strict as assert } from "node:assert";
import { quotePowerShell, quoteShell } from "../../.tmp/test-build/src/strings.js";

test("quotes shell values without losing embedded single quotes", () => {
  assert.equal(quoteShell("simple"), "'simple'");
  assert.equal(quoteShell("it's here"), "'it'\\''s here'");
});

test("quotes PowerShell values without expanding variables or escapes", () => {
  assert.equal(quotePowerShell("simple"), "\"simple\"");
  assert.equal(quotePowerShell("`$HOME \"quoted\""), "\"```$HOME `\"quoted`\"\"");
});
