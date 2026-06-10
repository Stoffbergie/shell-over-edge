import { test, vi } from "vitest";
import { strict as assert } from "node:assert";
import { app } from "../../src/worker/app";
import { createSession, createTestEnv, text, type TestFixture } from "../helpers/fake-env";

console.info = () => {};

test("session creation returns relay-only scripts keyed by a short code capability", async () => {
  const fixture = createTestEnv();
  const infoLines: string[] = [];
  const info = vi.spyOn(console, "info").mockImplementation((line) => {
    infoLines.push(String(line));
  });
  const shell = await createSession(app, fixture);
  assert.equal(shell.contentType, "text/x-shellscript; charset=utf-8");
  assert.equal(shell.code, shell.id);
  assert.match(shell.id, /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
  assert.ok(shell.script.startsWith("#!/bin/sh"));
  assert.ok(shell.script.includes(`SESSION_ID='${shell.id}'`));
  assert.ok(shell.script.includes(`/api/sessions/$SESSION_ID/next`));
  assert.ok(shell.script.includes("Session: %s (%s)\\nStop anytime: Ctrl+C\\n"));
  assert.ok(shell.script.includes("copy_text()"));
  assert.ok(!shell.script.includes("Send command:"));
  assert.ok(!shell.script.includes("Expires:"));
  assert.ok(!shell.script.includes("soe-agent"));
  assert.ok(!shell.script.includes("soe-webrtc"));
  assert.ok(!shell.script.includes("Authorization: Bearer"));
  assert.ok(!shell.script.includes("X-Agent-User"));
  assert.ok(!shell.script.includes("$(whoami)"));
  assert.ok(!shell.script.includes("--data-binary \"$(pwd)\""));
  assert.ok(!shell.script.includes("?token" + "="));
  assert.ok(!shell.script.includes("sh \"$AGENT_FILE\""));

  const powerShell = await createSession(app, fixture, "/a.ps1");
  assert.equal(powerShell.contentType, "text/plain; charset=utf-8");
  assert.match(powerShell.id, /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
  assert.ok(powerShell.script.includes(`$SessionId = "${powerShell.id}"`));
  assert.ok(powerShell.script.includes("/api/sessions/$SessionId/next"));
  assert.ok(powerShell.script.includes('Write-Host "Session: $SessionId ($Clipboard)"'));
  assert.ok(powerShell.script.includes('Write-Host "Stop anytime: Ctrl+C"'));
  assert.ok(powerShell.script.includes("Set-Clipboard"));
  assert.ok(!powerShell.script.includes('Write-Host "Send command:"'));
  assert.ok(!powerShell.script.includes('Write-Host "Expires:'));
  assert.ok(!powerShell.script.includes("soe-agent"));
  assert.ok(!powerShell.script.includes("soe-webrtc"));
  assert.ok(!powerShell.script.includes("Authorization"));
  assert.ok(!powerShell.script.includes("X-Agent-User"));
  assert.ok(!powerShell.script.includes("[Environment]::UserName"));
  assert.ok(!powerShell.script.includes("(Get-Location).Path"));
  assert.ok(!powerShell.script.includes("?token" + "="));

  info.mockRestore();
  console.info = () => {};
  const logs = infoLines.join("\n");
  assert.ok(!logs.includes(shell.id));
  assert.ok(!logs.includes(powerShell.id));
});

test("send waits for the agent result and returns plain command output", async () => {
  const fixture = createTestEnv();
  const session = await createSession(app, fixture);

  const hello = await app.request(`/api/sessions/${session.id}/hello`, {
    method: "POST",
    headers: {
      "X-Agent-Platform": "linux"
    }
  }, fixture.env, fixture.ctx);
  assert.equal(hello.status, 200);
  assert.equal(await text(hello), "connected\n");

  const sendJson = app.request(`/api/sessions/${session.id}/send?timeout=12`, {
    method: "POST",
    body: '{"body":"pwd","cwd":"/tmp"}'
  }, fixture.env, fixture.ctx);

  const nextJson = await waitForNext(session.id, fixture);
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

test("parallel sends keep command results matched under burst load", async () => {
  const fixture = createTestEnv();
  const session = await createSession(app, fixture);
  const count = 16;
  const sends = Array.from({ length: count }, (_, index) => {
    const body = `printf item-${index}`;
    return {
      body,
      response: app.request(`/api/sessions/${session.id}/send?timeout=20`, {
        method: "POST",
        body: JSON.stringify({ body })
      }, fixture.env, fixture.ctx)
    };
  });

  const commands = [];
  for (let index = 0; index < count; index += 1) {
    const next = await waitForNext(session.id, fixture);
    commands.push({
      id: next.headers.get("X-Command-Id") || "",
      body: await text(next)
    });
  }
  assert.equal(new Set(commands.map((command) => command.id)).size, count);

  for (const command of commands.reverse()) {
    const result = await app.request(`/api/sessions/${session.id}/result/${command.id}?exit=0`, {
      method: "POST",
      body: `done:${command.body}`
    }, fixture.env, fixture.ctx);
    assert.equal(result.status, 200);
    assert.equal(await text(result), "ok\n");
  }

  const responses = await Promise.all(sends.map(async (send) => ({
    body: send.body,
    response: await send.response
  })));
  for (const item of responses) {
    assert.equal(item.response.status, 200);
    assert.equal(item.response.headers.get("X-Exit-Code"), "0");
    assert.equal(await text(item.response), `done:${item.body}`);
  }
});

test("late known command results are acknowledged after helper timeout", async () => {
  const fixture = createTestEnv();
  const session = await createSession(app, fixture);
  const send = app.request(`/api/sessions/${session.id}/send?timeout=1`, {
    method: "POST",
    body: '{"body":"slow"}'
  }, fixture.env, fixture.ctx);

  const next = await waitForNext(session.id, fixture);
  const commandId = next.headers.get("X-Command-Id") || "";
  assert.equal(await text(next), "slow");

  await sleep(2200);

  const timedOut = await send;
  assert.equal(timedOut.status, 504);
  assert.equal(await text(timedOut), "Timed out waiting for command result\n");

  const late = await app.request(`/api/sessions/${session.id}/result/${commandId}?exit=0`, {
    method: "POST",
    body: "too-late"
  }, fixture.env, fixture.ctx);
  assert.equal(late.status, 200);
  assert.equal(await text(late), "ok\n");

  const unknown = await app.request(`/api/sessions/${session.id}/result/not-a-command?exit=0`, {
    method: "POST",
    body: "missing"
  }, fixture.env, fixture.ctx);
  assert.equal(unknown.status, 404);
  assert.equal(await text(unknown), "Command not found\n");
});

test("invalid sessions, bad send payloads, and removed routes return text errors", async () => {
  const fixture = createTestEnv();
  const session = await createSession(app, fixture);

  const internalIdSend = await app.request(`/api/sessions/${session.internalId}/send`, {
    method: "POST",
    body: "pwd"
  }, fixture.env, fixture.ctx);
  assert.equal(internalIdSend.status, 404);
  assert.equal(await text(internalIdSend), "Session not found\n");

  const invalidPayload = await app.request(`/api/sessions/${session.id}/send`, {
    method: "POST",
    body: "{"
  }, fixture.env, fixture.ctx);
  assert.equal(invalidPayload.status, 400);
  assert.equal(await text(invalidPayload), "Invalid JSON command payload\n");

  const bodyTimeout = await app.request(`/api/sessions/${session.id}/send`, {
    method: "POST",
    body: '{"body":"pwd","timeoutSeconds":12}'
  }, fixture.env, fixture.ctx);
  assert.equal(bodyTimeout.status, 400);
  assert.equal(await text(bodyTimeout), "Use ?timeout= for command timeout\n");

  assert.equal((await app.request(`/api/sessions/${session.id}/probe`, {}, fixture.env, fixture.ctx)).status, 404);
  assert.equal((await app.request(`/api/sessions/${session.id}/config`, { method: "POST" }, fixture.env, fixture.ctx)).status, 404);
  assert.equal((await app.request(`/api/sessions/${session.id}/ice`, {}, fixture.env, fixture.ctx)).status, 404);
  assert.equal((await app.request(`/api/sessions/${session.id}/signals`, { method: "POST" }, fixture.env, fixture.ctx)).status, 404);
  assert.equal((await app.request(`/start/${session.id}.sh`, {}, fixture.env, fixture.ctx)).status, 404);
  assert.equal((await app.request(`/api/agent/${session.id}/next`, {}, fixture.env, fixture.ctx)).status, 404);
  assert.equal((await app.request(`/api/sessions/${session.id}/commands`, { method: "POST" }, fixture.env, fixture.ctx)).status, 404);
  assert.equal((await app.request(`/api/sessions/${session.id}/upload`, { method: "POST" }, fixture.env, fixture.ctx)).status, 404);
  assert.equal((await app.request(`/api/sessions/${session.id}/candidates`, { method: "POST" }, fixture.env, fixture.ctx)).status, 404);
  assert.equal((await app.request(`/api/sessions/${session.id}/direct-attempts`, { method: "POST" }, fixture.env, fixture.ctx)).status, 404);
  assert.equal((await app.request("/connect.sh", {}, fixture.env, fixture.ctx)).status, 404);
  assert.equal((await app.request("/a", {}, fixture.env, fixture.ctx)).status, 404);
  assert.equal((await app.request("/api/sessions", { method: "POST" }, fixture.env, fixture.ctx)).status, 404);
  assert.equal((await app.request("/api/sessions.ps1", { method: "POST" }, fixture.env, fixture.ctx)).status, 404);

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
