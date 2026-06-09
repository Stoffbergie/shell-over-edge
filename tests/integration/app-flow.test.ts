import { test } from "vitest";
import { strict as assert } from "node:assert";
import { app } from "../../src/worker/app";
import { createSession, createTestEnv, text, type TestFixture } from "../helpers/fake-env";

console.info = () => {};

test("session creation returns plain scripts keyed by a uuid capability", async () => {
  const fixture = createTestEnv();
  const shell = await createSession(app, fixture);
  assert.equal(shell.contentType, "text/x-shellscript; charset=utf-8");
  assert.equal(shell.code, shell.id);
  assert.ok(shell.script.startsWith("#!/bin/sh"));
  assert.ok(shell.script.includes(`SESSION_ID='${shell.id}'`));
  assert.ok(shell.script.includes(`/api/sessions/$SESSION_ID/next`));
  assert.ok(shell.script.includes("/api/sessions/%s/send"));
  assert.ok(shell.script.includes("copy_text()"));
  assert.ok(!shell.script.includes("Authorization: Bearer"));
  assert.ok(!shell.script.includes("?token" + "="));

  const powerShell = await createSession(app, fixture, "/api/sessions.ps1");
  assert.equal(powerShell.contentType, "text/plain; charset=utf-8");
  assert.ok(powerShell.script.includes(`$SessionId = "${powerShell.id}"`));
  assert.ok(powerShell.script.includes("/api/sessions/$SessionId/next"));
  assert.ok(powerShell.script.includes("Set-Clipboard"));
  assert.ok(!powerShell.script.includes("Authorization"));
  assert.ok(!powerShell.script.includes("?token" + "="));
});

test("send waits for the agent result and returns plain command output", async () => {
  const fixture = createTestEnv();
  const session = await createSession(app, fixture);

  const hello = await app.request(`/api/sessions/${session.id}/hello`, {
    method: "POST",
    headers: {
      "X-Agent-Platform": "linux",
      "X-Agent-User": "runner"
    },
    body: "/tmp"
  }, fixture.env, fixture.ctx);
  assert.equal(hello.status, 200);
  assert.equal(await text(hello), "connected\n");

  const sendJson = app.request(`/api/sessions/${session.id}/send`, {
    method: "POST",
    body: '{"body":"pwd","cwd":"/tmp","timeoutSeconds":12}'
  }, fixture.env, fixture.ctx);

  const nextJson = await waitForNext(session.id, fixture);
  assert.equal(nextJson.headers.get("X-Command-Type"), "shell");
  assert.equal(nextJson.headers.get("X-Command-Timeout"), "12");
  assert.equal(Buffer.from(nextJson.headers.get("X-Command-Cwd-Base64") || "", "base64").toString("utf8"), "/tmp");
  assert.equal(await text(nextJson), "pwd");

  const resultJson = await app.request(`/api/sessions/${session.id}/result/${nextJson.headers.get("X-Command-Id")}?exit=0`, {
    method: "POST",
    body: "ok\n"
  }, fixture.env, fixture.ctx);
  assert.equal(resultJson.status, 200);

  const sentJson = await sendJson;
  assert.equal(sentJson.status, 200);
  assert.equal(sentJson.headers.get("X-Exit-Code"), "0");
  assert.equal(await text(sentJson), "ok\n");

  const sendRaw = app.request(`/api/sessions/${session.id}/send?timeout=3`, {
    method: "POST",
    body: "whoami"
  }, fixture.env, fixture.ctx);
  const nextRaw = await waitForNext(session.id, fixture);
  assert.equal(nextRaw.headers.get("X-Command-Timeout"), "3");
  assert.equal(await text(nextRaw), "whoami");

  const resultRaw = await app.request(`/api/sessions/${session.id}/result/${nextRaw.headers.get("X-Command-Id")}?exit=7`, {
    method: "POST",
    body: "nope\n"
  }, fixture.env, fixture.ctx);
  assert.equal(resultRaw.status, 200);

  const sentRaw = await sendRaw;
  assert.equal(sentRaw.status, 500);
  assert.equal(sentRaw.headers.get("X-Exit-Code"), "7");
  assert.equal(await text(sentRaw), "nope\n");
});

test("sessions exchange short-lived direct transport candidates", async () => {
  const fixture = createTestEnv();
  const session = await createSession(app, fixture);

  const invalid = await app.request(`/api/sessions/${session.id}/candidates`, {
    method: "POST",
    body: '{"role":"agent","url":"ftp://127.0.0.1/direct"}'
  }, fixture.env, fixture.ctx);
  assert.equal(invalid.status, 400);
  assert.equal(await text(invalid), "Invalid direct candidate\n");

  const published = await app.request(`/api/sessions/${session.id}/candidates`, {
    method: "POST",
    body: '{"role":"agent","transport":"http","url":"http://127.0.0.1:9999/direct","priority":5,"ttlSeconds":30}'
  }, fixture.env, fixture.ctx);
  assert.equal(published.status, 201);
  const candidate = await published.json() as { id: string; role: string; transport: string; url: string; priority: number };
  assert.ok(candidate.id);
  assert.equal(candidate.role, "agent");
  assert.equal(candidate.transport, "http");
  assert.equal(candidate.url, "http://127.0.0.1:9999/direct");
  assert.equal(candidate.priority, 5);

  const client = await app.request(`/api/sessions/${session.id}/candidates`, {
    method: "POST",
    body: '{"role":"client","transport":"http","url":"http://127.0.0.1:8888/direct","priority":50}'
  }, fixture.env, fixture.ctx);
  assert.equal(client.status, 201);

  const agents = await app.request(`/api/sessions/${session.id}/candidates?role=agent`, {}, fixture.env, fixture.ctx);
  assert.equal(agents.status, 200);
  const listed = await agents.json() as { candidates: Array<{ id: string; role: string; priority: number }> };
  assert.equal(listed.candidates.length, 1);
  assert.equal(listed.candidates[0]?.id, candidate.id);
  assert.equal(listed.candidates[0]?.role, "agent");

  const badRole = await app.request(`/api/sessions/${session.id}/candidates?role=helper`, {}, fixture.env, fixture.ctx);
  assert.equal(badRole.status, 400);
  assert.equal(await text(badRole), "Invalid direct candidate role\n");

  const attempt = await app.request(`/api/sessions/${session.id}/direct-attempts`, {
    method: "POST",
    body: JSON.stringify({ candidateId: candidate.id, ok: false, latencyMs: 32, reason: "http-404" })
  }, fixture.env, fixture.ctx);
  assert.equal(attempt.status, 200);
  assert.equal(await text(attempt), "ok\n");
});

test("invalid sessions, bad send payloads, and retired routes return text errors", async () => {
  const fixture = createTestEnv();
  const session = await createSession(app, fixture);

  const invalidPayload = await app.request(`/api/sessions/${session.id}/send`, {
    method: "POST",
    body: "{"
  }, fixture.env, fixture.ctx);
  assert.equal(invalidPayload.status, 400);
  assert.equal(await text(invalidPayload), "Invalid JSON command payload\n");

  const oldStart = await app.request(`/start/${session.id}.sh`, {}, fixture.env, fixture.ctx);
  assert.equal(oldStart.status, 404);
  assert.equal(await text(oldStart), "Not found\n");

  assert.equal((await app.request(`/api/agent/${session.id}/next`, {}, fixture.env, fixture.ctx)).status, 404);
  assert.equal((await app.request(`/api/sessions/${session.id}/commands`, { method: "POST" }, fixture.env, fixture.ctx)).status, 404);
  assert.equal((await app.request(`/api/sessions/${session.id}/upload`, { method: "POST" }, fixture.env, fixture.ctx)).status, 404);
  assert.equal((await app.request("/connect.sh", {}, fixture.env, fixture.ctx)).status, 404);

  const end = await app.request(`/api/sessions/${session.id}/end`, { method: "POST" }, fixture.env, fixture.ctx);
  assert.equal(end.status, 200);
  assert.equal(await text(end), "ended\n");

  const blocked = await app.request(`/api/sessions/${session.id}/send`, {
    method: "POST",
    body: "pwd"
  }, fixture.env, fixture.ctx);
  assert.equal(blocked.status, 410);
  assert.equal(await text(blocked), "Session ended\n");
});

async function waitForNext(sessionId: string, fixture: TestFixture): Promise<Response> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await app.request(`/api/sessions/${sessionId}/next`, {}, fixture.env, fixture.ctx);
    if (response.status === 200) return response;
    assert.equal(response.status, 204);
    await sleep(50);
  }
  throw new Error("Timed out waiting for queued command");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
