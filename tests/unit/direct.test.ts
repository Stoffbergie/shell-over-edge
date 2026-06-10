import { test } from "vitest";
import { strict as assert } from "node:assert";
import { normalizeDirectSignal, normalizeIceServers, normalizeWebRtcSignalData } from "../../src/domain/direct";

test("normalizes HTTP direct signals", () => {
  const signal = normalizeDirectSignal({
    role: "agent",
    transport: "http",
    url: "http://user:pass@127.0.0.1:9999/direct#secret",
    priority: 5,
    ttlSeconds: 30
  }, "signal-1", 1000, 60_000);

  assert.equal(signal?.id, "signal-1");
  assert.equal(signal?.role, "agent");
  assert.equal(signal?.transport, "http");
  assert.equal(signal?.url, "http://127.0.0.1:9999/direct");
  assert.equal(signal?.priority, 5);
  assert.equal(signal?.expiresAt, 31_000);
});

test("normalizes WebRTC offer and candidate signal data", () => {
  const offer = normalizeWebRtcSignalData({ type: "offer", sdp: "v=0\r\n", connectionId: "conn-1" });
  assert.deepEqual(offer, { kind: "offer", connectionId: "conn-1", sdp: "v=0\r\n" });

  const candidate = normalizeWebRtcSignalData({ candidate: "candidate:1 udp 1 127.0.0.1 5000 typ host", connectionId: "conn-1", sdpMid: "0", sdpMLineIndex: 0 });
  assert.deepEqual(candidate, {
    kind: "candidate",
    connectionId: "conn-1",
    candidate: "candidate:1 udp 1 127.0.0.1 5000 typ host",
    sdpMid: "0",
    sdpMLineIndex: 0
  });
});

test("rejects invalid direct signals", () => {
  assert.equal(normalizeDirectSignal({ role: "agent", transport: "http", url: "ftp://127.0.0.1/direct" }, "id", 0, 60_000), undefined);
  assert.equal(normalizeDirectSignal({ role: "agent", transport: "webrtc", data: { type: "offer" } }, "id", 0, 60_000), undefined);
  assert.equal(normalizeDirectSignal({ role: "helper", transport: "http", url: "http://127.0.0.1/direct" }, "id", 0, 60_000), undefined);
});

test("normalizes ICE server lists", () => {
  const servers = normalizeIceServers([
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "https://example.com/nope"], username: "user", credential: "pass" },
    { urls: "file:///tmp/nope" }
  ]);

  assert.deepEqual(servers, [
    { urls: ["stun:stun.cloudflare.com:3478"] },
    { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "user", credential: "pass" }
  ]);
});
