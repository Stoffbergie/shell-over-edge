import { test } from "vitest";
import { strict as assert } from "node:assert";
import { cleanupExpiredSessions, codeKey, getJson, metaKey, putJson, putSessionCode, resolveSessionCode } from "../../src/worker/services/session-store";
import type { SessionMeta } from "../../src/domain/session";
import { createTestEnv } from "../helpers/fake-env";

test("cleanup expires old active sessions and deletes retained data", async () => {
  const { env, mailbox } = createTestEnv();
  const now = Date.now();
  const expiring = {
    id: "sess_expiring",
    status: "waiting",
    createdAt: now - 10_000,
    expiresAt: now - 1
  };
  const retained = {
    ...expiring,
    id: "sess_retained",
    expiresAt: now - 25 * 60 * 60 * 1000
  };

  await putJson(env, metaKey(expiring.id), expiring);
  await putJson(env, metaKey(retained.id), retained);
  await putJson(env, `sessions/${retained.id}/commands/cmd.json`, { ok: true });

  await cleanupExpiredSessions(env);

  assert.equal((await getJson<SessionMeta>(env, metaKey(expiring.id)))?.status, "expired");
  assert.equal(await mailbox.get(metaKey(retained.id)), null);
  assert.equal(await mailbox.get(`sessions/${retained.id}/commands/cmd.json`), null);
});

test("session code resolution caches R2 lookups", async () => {
  const { env, mailbox } = createTestEnv();
  const code = "23456789";
  const id = "fd81ca7c-c0f3-4960-b6c5-2a0e38553768";

  await putJson(env, codeKey(code), { id });

  assert.equal(await resolveSessionCode(env, code), id);
  assert.equal(await resolveSessionCode(env, code), id);
  assert.equal(mailbox.gets.get(codeKey(code)), 1);
});

test("session code writes warm the resolver cache", async () => {
  const { env, mailbox } = createTestEnv();
  const code = "abcdefgh";
  const id = "1ee1f508-5236-45a4-b4d5-3d5585f81dc7";

  await putSessionCode(env, code, id);

  assert.equal(await resolveSessionCode(env, code), id);
  assert.equal(mailbox.gets.get(codeKey(code)) || 0, 0);
});
