import { test } from "node:test";
import { strict as assert } from "node:assert";
import { appendEvent, cleanupExpiredSessions, commandKey, enqueueCommand, getJson, listEvents, metaKey, nextQueuedCommand, putJson } from "../../.tmp/test-build/src/session-store.js";
import { createTestEnv } from "../helpers/fake-env.mjs";

test("queues commands in order and skips stale queue entries", async () => {
  const { env } = createTestEnv();
  const first = await enqueueCommand(env, "sess_1", { type: "shell", body: "pwd", timeoutSeconds: 30 });
  const second = await enqueueCommand(env, "sess_1", { type: "shell", body: "whoami", timeoutSeconds: 30 });

  const running = { ...first, status: "running" };
  await putJson(env, commandKey("sess_1", first.id), running);

  assert.deepEqual(await nextQueuedCommand(env, "sess_1"), second);
  await putJson(env, commandKey("sess_1", second.id), { ...second, status: "running" });
  assert.equal(await nextQueuedCommand(env, "sess_1"), null);
});

test("empty polls do not create an empty queue that can clobber later commands", async () => {
  const { env } = createTestEnv();
  const put = env.SOE_MAILBOX.put.bind(env.SOE_MAILBOX);
  env.SOE_MAILBOX.put = async (key, value, options) => {
    assert.notEqual(`${key}:${value}`, "sessions/sess_1/command-queue.json:[]");
    return put(key, value, options);
  };

  assert.equal(await nextQueuedCommand(env, "sess_1"), null);

  const command = await enqueueCommand(env, "sess_1", { type: "shell", body: "pwd", timeoutSeconds: 30 });
  assert.deepEqual(await nextQueuedCommand(env, "sess_1"), command);
});

test("lists only a sorted 100-event window", async () => {
  const { env } = createTestEnv();
  for (let index = 0; index < 125; index += 1) {
    await appendEvent(env, "sess_1", { type: "test", message: String(index) });
  }

  const events = await listEvents(env, "sess_1", "");
  assert.equal(events.length, 100);
  assert.deepEqual([...events].sort((a, b) => a.id.localeCompare(b.id)), events);

  const after = events[49].id;
  const laterEvents = await listEvents(env, "sess_1", after);
  assert.ok(laterEvents.length <= 100);
  assert.ok(laterEvents.every((event) => event.id > after));
});

test("cleanup expires old active sessions and deletes retained data", async () => {
  const { env, mailbox } = createTestEnv();
  const now = Date.now();
  const expiring = {
    id: "sess_expiring",
    code: "BR-EXPIR",
    helperName: "Ada",
    status: "waiting",
    createdAt: now - 10_000,
    expiresAt: now - 1
  };
  const retained = {
    ...expiring,
    id: "sess_retained",
    code: "BR-OLD01",
    expiresAt: now - 25 * 60 * 60 * 1000
  };

  await putJson(env, metaKey(expiring.id), expiring);
  await putJson(env, metaKey(retained.id), retained);
  await putJson(env, `sessions/${retained.id}/commands/cmd.json`, { ok: true });

  await cleanupExpiredSessions(env);

  assert.equal((await getJson(env, metaKey(expiring.id))).status, "expired");
  assert.equal(await mailbox.get(metaKey(retained.id)), null);
  assert.equal(await mailbox.get(`sessions/${retained.id}/commands/cmd.json`), null);
});
