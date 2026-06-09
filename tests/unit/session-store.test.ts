import { test } from "vitest";
import { strict as assert } from "node:assert";
import { cleanupExpiredSessions, getJson, metaKey, putJson } from "../../src/worker/services/session-store";
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
