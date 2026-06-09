import { test } from "vitest";
import { strict as assert } from "node:assert";
import { getIceServers, normalizeTurnCredentialTtl } from "../../src/worker/services/ice-servers";
import type { Env } from "../../src/worker/env";

test("returns Cloudflare STUN when TURN secrets are absent", async () => {
  const result = await getIceServers({} as Env, async () => {
    throw new Error("fetch should not run");
  });

  assert.deepEqual(result.iceServers, [{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  assert.equal(result.source, "cloudflare-stun");
  assert.equal(result.turnEnabled, false);
  assert.equal(result.ttlSeconds, 7200);
});

test("generates short-lived Cloudflare TURN ICE servers", async () => {
  const calls: Array<{ url: string; authorization: string; body: string }> = [];
  const result = await getIceServers({
    TURN_KEY_ID: "key-id",
    TURN_KEY_API_TOKEN: "token",
    TURN_CREDENTIAL_TTL_SECONDS: "120",
    TURN_API_BASE_URL: "https://rtc.example.test/"
  } as Env, (async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      authorization: headers.get("Authorization") || "",
      body: String(init?.body || "")
    });
    return Response.json({
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
        { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp"], username: "user", credential: "pass" },
        { urls: ["turns:turn.cloudflare.com:443?transport=tcp"] }
      ]
    });
  }) as typeof fetch);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://rtc.example.test/v1/turn/keys/key-id/credentials/generate-ice-servers");
  assert.equal(calls[0]?.authorization, "Bearer token");
  assert.equal(calls[0]?.body, '{"ttl":120}');
  assert.equal(result.source, "cloudflare-turn");
  assert.equal(result.turnEnabled, true);
  assert.deepEqual(result.iceServers, [
    { urls: ["stun:stun.cloudflare.com:3478"] },
    { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "user", credential: "pass" },
    { urls: ["turns:turn.cloudflare.com:443?transport=tcp"] }
  ]);
});

test("falls back to STUN on TURN API failures", async () => {
  const result = await getIceServers({
    TURN_KEY_ID: "key-id",
    TURN_KEY_API_TOKEN: "token"
  } as Env, (async () => new Response("nope", { status: 500 })) as typeof fetch);

  assert.equal(result.source, "cloudflare-stun");
  assert.equal(result.turnEnabled, false);
  assert.deepEqual(result.iceServers, [{ urls: ["stun:stun.cloudflare.com:3478"] }]);
});

test("clamps TURN credential TTL", () => {
  assert.equal(normalizeTurnCredentialTtl("59"), 60);
  assert.equal(normalizeTurnCredentialTtl("120"), 120);
  assert.equal(normalizeTurnCredentialTtl("999999"), 172800);
  assert.equal(normalizeTurnCredentialTtl("bad"), 7200);
});
