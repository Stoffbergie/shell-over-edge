import { performance } from "node:perf_hooks";
import { test } from "vitest";
import { strict as assert } from "node:assert";
import { app } from "../../src/worker/app";
import { createTestEnv } from "../helpers/fake-env";
import { startAppServer } from "../helpers/server";

console.info = () => {};

test("relay bridge handles a burst of parallel commands without timeouts or result mixups", async () => {
  const fixture = createTestEnv();
  const server = await startAppServer(app, fixture);
  try {
    const session = await createSession(server.baseUrl);
    const count = 64;
    const startedAt = performance.now();
    const sends = Array.from({ length: count }, (_, index) => {
      const body = `load-${index}`;
      return sendCommand(server.baseUrl, session.id, body).then((response) => ({ body, response }));
    });

    const commands = [];
    for (let index = 0; index < count; index += 1) {
      commands.push(await nextCommand(server.baseUrl, session.id));
    }

    for (const command of commands.reverse()) {
      const response = await fetch(`${server.baseUrl}/api/sessions/${session.id}/result/${command.id}?exit=0`, {
        method: "POST",
        body: `done:${command.body}`
      });
      assert.equal(response.status, 200);
    }

    const results = await Promise.all(sends);
    const elapsedMs = performance.now() - startedAt;
    assert.ok(elapsedMs < 2500, `relay burst took ${elapsedMs}ms`);
    assert.equal(new Set(commands.map((command) => command.id)).size, count);
    for (const item of results) {
      assert.equal(item.response.status, 200);
      assert.equal(item.response.text, `done:${item.body}`);
    }
  } finally {
    await server.close();
  }
});

async function createSession(baseUrl: string): Promise<{ id: string }> {
  const response = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
  assert.equal(response.status, 200);
  const id = response.headers.get("X-Session-Id") || "";
  assert.match(id, /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
  await response.text();
  return { id };
}

async function sendCommand(baseUrl: string, id: string, body: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`${baseUrl}/api/sessions/${id}/send`, {
    method: "POST",
    body: JSON.stringify({ body, timeoutSeconds: 20 })
  });
  return { status: response.status, text: await response.text() };
}

async function nextCommand(baseUrl: string, sessionId: string): Promise<{ id: string; body: string }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/next`);
    if (response.status === 200) {
      const id = response.headers.get("X-Command-Id") || "";
      assert.ok(id);
      return { id, body: await response.text() };
    }
    assert.equal(response.status, 204);
    await sleep(25);
  }
  throw new Error("Timed out waiting for load-test command");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
