import { test } from "node:test";
import { strict as assert } from "node:assert";
import { app } from "../../.tmp/test-build/src/app.js";
import { auth, createSession, createTestEnv, json, text } from "../helpers/fake-env.mjs";

console.info = () => {};

const legacyCode = ["550e8400", "e29b", "41d4", "a716", "446655440000"].join("-");

test("helper and agent can complete a shell command round trip", async () => {
  const fixture = createTestEnv();
  const session = await createSession(app, fixture);

  assert.equal(session.status, "waiting");
  assert.match(session.id, /^sess_/);
  assert.match(session.code, /^BR-/);
  assert.ok(session.shellCommand.includes("https://soe.test/start/"));
  assert.ok(session.windowsCommand.includes("https://soe.test/start/"));
  assert.ok(!session.shellCommand.includes("?token" + "="));
  assert.ok(!session.windowsCommand.includes("?token" + "="));

  const unauthorized = await app.request(`/api/sessions/${session.id}`, {}, fixture.env, fixture.ctx);
  assert.equal(unauthorized.status, 401);

  const hello = await app.request(`/api/agent/${session.code}/hello`, {
    method: "POST",
    headers: { ...auth(session.agentToken), "Content-Type": "application/json" },
    body: JSON.stringify({ platform: "linux", user: "runner", cwd: "/tmp" })
  }, fixture.env, fixture.ctx);
  assert.equal(hello.status, 200);
  assert.equal((await json(hello)).status, "connected");

  const queued = await app.request(`/api/sessions/${session.id}/commands`, {
    method: "POST",
    headers: { ...auth(session.helperToken), "Content-Type": "application/json" },
    body: JSON.stringify({ body: "pwd", cwd: "/tmp", timeoutSeconds: 12 })
  }, fixture.env, fixture.ctx);
  assert.equal(queued.status, 200);
  const { commandId } = await json(queued);

  const next = await app.request(`/api/agent/${session.code}/next`, {
    headers: auth(session.agentToken)
  }, fixture.env, fixture.ctx);
  assert.equal(next.status, 200);
  assert.equal(next.headers.get("X-Command-Id"), commandId);
  assert.equal(next.headers.get("X-Command-Type"), "shell");
  assert.equal(next.headers.get("X-Command-Timeout"), "12");
  assert.equal(Buffer.from(next.headers.get("X-Command-Cwd-Base64"), "base64").toString("utf8"), "/tmp");
  assert.equal(await text(next), "pwd");

  const result = await app.request(`/api/agent/${session.code}/result/${commandId}?exit=0`, {
    method: "POST",
    headers: auth(session.agentToken),
    body: "ok\n"
  }, fixture.env, fixture.ctx);
  assert.equal(result.status, 200);

  const events = await app.request(`/api/sessions/${session.id}/events`, {
    headers: auth(session.helperToken)
  }, fixture.env, fixture.ctx);
  const eventPayload = await json(events);
  assert.equal(eventPayload.status, "connected");
  assert.ok(eventPayload.events.some((event) => event.type === "command_result" && event.output === "ok\n"));

  const end = await app.request(`/api/sessions/${session.id}/end`, {
    method: "POST",
    headers: auth(session.helperToken)
  }, fixture.env, fixture.ctx);
  assert.equal(end.status, 200);
  assert.equal((await json(end)).status, "ended");

  const blocked = await app.request(`/api/sessions/${session.id}/commands`, {
    method: "POST",
    headers: { ...auth(session.helperToken), "Content-Type": "application/json" },
    body: JSON.stringify({ body: "whoami" })
  }, fixture.env, fixture.ctx);
  assert.equal(blocked.status, 410);
});

test("file upload and download flow preserves bytes and transfer headers", async () => {
  const fixture = createTestEnv();
  const session = await createSession(app, fixture);
  const form = new FormData();
  form.set("path", "/tmp/hello.txt");
  form.set("file", new File(["hello"], "hello.txt", { type: "text/plain" }));

  const upload = await app.request(`/api/sessions/${session.id}/upload`, {
    method: "POST",
    headers: auth(session.helperToken),
    body: form
  }, fixture.env, fixture.ctx);
  assert.equal(upload.status, 200);
  const uploadPayload = await json(upload);

  const writeCommand = await app.request(`/api/agent/${session.code}/next`, {
    headers: auth(session.agentToken)
  }, fixture.env, fixture.ctx);
  assert.equal(writeCommand.status, 200);
  assert.equal(writeCommand.headers.get("X-Command-Id"), uploadPayload.commandId);
  assert.equal(writeCommand.headers.get("X-Command-Type"), "write-file");
  assert.equal(Buffer.from(writeCommand.headers.get("X-Command-Path-Base64"), "base64").toString("utf8"), "/tmp/hello.txt");
  assert.equal(Buffer.from(await writeCommand.arrayBuffer()).toString("utf8"), "hello");

  const writeResult = await app.request(`/api/agent/${session.code}/result/${uploadPayload.commandId}?exit=0`, {
    method: "POST",
    headers: auth(session.agentToken),
    body: "wrote"
  }, fixture.env, fixture.ctx);
  assert.equal(writeResult.status, 200);

  const download = await app.request(`/api/sessions/${session.id}/download`, {
    method: "POST",
    headers: { ...auth(session.helperToken), "Content-Type": "application/json" },
    body: JSON.stringify({ path: "/tmp/hello.txt" })
  }, fixture.env, fixture.ctx);
  assert.equal(download.status, 200);
  const downloadPayload = await json(download);

  const readCommand = await app.request(`/api/agent/${session.code}/next`, {
    headers: auth(session.agentToken)
  }, fixture.env, fixture.ctx);
  assert.equal(readCommand.headers.get("X-Command-Type"), "read-file");
  assert.equal(readCommand.headers.get("X-Download-Id"), downloadPayload.downloadId);
  assert.equal(Buffer.from(readCommand.headers.get("X-Command-Path-Base64"), "base64").toString("utf8"), "/tmp/hello.txt");

  const readResult = await app.request(`/api/agent/${session.code}/result/${readCommand.headers.get("X-Command-Id")}?exit=0`, {
    method: "POST",
    headers: auth(session.agentToken),
    body: "download bytes"
  }, fixture.env, fixture.ctx);
  assert.equal(readResult.status, 200);

  const file = await app.request(`/api/sessions/${session.id}/downloads/${downloadPayload.downloadId}`, {
    headers: auth(session.helperToken)
  }, fixture.env, fixture.ctx);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("Content-Disposition"), 'attachment; filename="hello.txt"');
  assert.equal(await text(file), "download bytes");
});

test("start scripts require bearer token and never accept URL tokens", async () => {
  const fixture = createTestEnv();
  const session = await createSession(app, fixture);

  const missing = await app.request(`/start/${session.code}.sh`, {}, fixture.env, fixture.ctx);
  assert.equal(missing.status, 400);

  const bad = await app.request(`/start/${session.code}.sh`, {
    headers: auth(["wrong", "value"].join("-"))
  }, fixture.env, fixture.ctx);
  assert.equal(bad.status, 401);

  const shell = await app.request(`/start/${session.code}.sh?token${"="}${session.agentToken}`, {}, fixture.env, fixture.ctx);
  assert.equal(shell.status, 400);

  const goodShell = await app.request(`/start/${session.code}.sh`, {
    headers: auth(session.agentToken)
  }, fixture.env, fixture.ctx);
  assert.equal(goodShell.status, 200);
  assert.match(await text(goodShell), /Authorization: Bearer \$TOKEN/);

  const goodPowerShell = await app.request(`/start/${session.code}.ps1`, {
    headers: auth(session.agentToken)
  }, fixture.env, fixture.ctx);
  assert.equal(goodPowerShell.status, 200);
  assert.match(await text(goodPowerShell), /\$Headers = @\{ Authorization = "Bearer \$Token" \}/);
});

test("legacy bridge stays disabled by default and forwards only when explicitly enabled", async () => {
  const disabled = createTestEnv();
  assert.equal((await app.request("/connect.sh", {}, disabled.env, disabled.ctx)).status, 404);
  assert.equal((await app.request(`/api/v1/${legacyCode}/events`, {}, disabled.env, disabled.ctx)).status, 404);

  const calls = [];
  const enabled = createTestEnv({
    legacyBridge: true,
    bridgeFetch: (id, request, init) => {
      calls.push({ id, request: String(request), init });
      return new Response("forwarded", { status: 202 });
    }
  });
  const code = legacyCode;
  const response = await app.request(`/api/v1/${code}/bye`, {
    method: "POST",
    headers: { "x-api-key": code }
  }, enabled.env, enabled.ctx);
  assert.equal(response.status, 202);
  assert.equal(calls[0].id, code);
  assert.equal(calls[0].request, "https://bridge/bye");
});
